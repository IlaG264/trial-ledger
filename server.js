import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { XMLParser } from "fast-xml-parser";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const ZOTERO_USER_ID = process.env.ZOTERO_USER_ID || "21263291";
const ZOTERO_API_KEY = process.env.ZOTERO_API_KEY || "";
const ZOTERO_API_BASE = "https://api.zotero.org";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text"
});

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Helpers

function arr(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (value === undefined || value === null) return "";

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(textOf).filter(Boolean).join(" ");
  }

  if (typeof value === "object") {
    if (value["#text"] !== undefined) {
      return textOf(value["#text"]);
    }

    return Object.values(value)
      .map(textOf)
      .filter(Boolean)
      .join(" ");
  }

  return "";
}

function cleanText(text, maxLen = 6000) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .trim()
    .slice(0, maxLen);
}

function stripXmlToText(xml, maxLen = 9000) {
  return cleanText(
    String(xml || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<ref-list[\s\S]*?<\/ref-list>/gi, " ")
      .replace(/<table-wrap[\s\S]*?<\/table-wrap>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
    maxLen
  );
}

function titleTokens(text) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "that",
    "this",
    "study",
    "trial",
    "randomized",
    "clinical",
    "comparison",
    "compared",
    "versus"
  ]);

  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopWords.has(word));
}

// Literature search queries

function buildPubMedQuery({
  nctId,
  briefTitle,
  officialTitle
}) {
  const parts = [];

  if (nctId) {
    parts.push(`${nctId}[All Fields]`);
  }

  if (briefTitle) {
    parts.push(`"${briefTitle}"[Title/Abstract]`);
  }

  if (officialTitle && officialTitle !== briefTitle) {
    parts.push(`"${officialTitle}"[Title/Abstract]`);
  }

  return (
    parts.join(" OR ") ||
    briefTitle ||
    officialTitle ||
    nctId
  );
}

function buildEuropeQuery({
  nctId,
  briefTitle,
  officialTitle
}) {
  const parts = [];

  if (nctId) {
    parts.push(`"${nctId}"`);
  }

  if (briefTitle) {
    parts.push(`"${briefTitle}"`);
  }

  if (officialTitle && officialTitle !== briefTitle) {
    parts.push(`"${officialTitle}"`);
  }

  return (
    parts.join(" OR ") ||
    briefTitle ||
    officialTitle ||
    nctId
  );
}

function ncbiParams() {
  return new URLSearchParams({
    tool: "clinical-trial-evidence-assistant"
  });
}

// HTTP helpers

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Request failed with status ${response.status}`
    );
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept:
        "application/xml,text/xml,text/plain,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Request failed with status ${response.status}`
    );
  }

  return response.text();
}

// PubMed

async function searchPubMed(query) {
  if (!query) {
    return [];
  }

  const params = ncbiParams();

  params.set("db", "pubmed");
  params.set("term", query);
  params.set("retmode", "json");
  params.set("retmax", "10");
  params.set("sort", "relevance");

  const url =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?` +
    params.toString();

  const data = await fetchJson(url);

  return data.esearchresult?.idlist || [];
}

function parsePubMedArticle(article) {
  const med = article.MedlineCitation || {};
  const pub = article.PubmedData || {};
  const art = med.Article || {};
  const journal = art.Journal || {};
  const pubDate =
    journal.JournalIssue?.PubDate || {};

  const ids = arr(
    pub.ArticleIdList?.ArticleId
  );

  const idByType = (type) => {
    const found = ids.find(
      (item) =>
        String(
          item?.["@_IdType"] || ""
        ).toLowerCase() === type.toLowerCase()
    );

    return textOf(found);
  };

  const pmid = textOf(med.PMID);

  return {
    sourceLabel: "PubMed",
    source: "MED",
    id: pmid,
    pmid,
    pmcid: idByType("pmc"),
    doi: idByType("doi"),
    title: cleanText(
      textOf(art.ArticleTitle),
      700
    ),
    journal: cleanText(
      textOf(journal.Title),
      300
    ),
    year:
      textOf(pubDate.Year) ||
      textOf(pubDate.MedlineDate).slice(0, 4),
    abstract: cleanText(
      textOf(art.Abstract?.AbstractText),
      6000
    ),
    url: pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      : "",
    isOpenAccess: false,
    hasFullText: false,
    openAccessFullTextFound: false,
    fullTextSnippet: "",
    fullTextUrl: ""
  };
}

async function fetchPubMedArticles(ids) {
  if (!ids.length) {
    return [];
  }

  const params = ncbiParams();

  params.set("db", "pubmed");
  params.set("id", ids.join(","));
  params.set("retmode", "xml");

  const url =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?` +
    params.toString();

  const xml = await fetchText(url);
  const parsed = xmlParser.parse(xml);

  return arr(
    parsed.PubmedArticleSet?.PubmedArticle
  )
    .map(parsePubMedArticle)
    .filter(
      (article) =>
        article.title ||
        article.abstract ||
        article.pmid
    );
}

// Europe PMC

function parseEuropeArticle(item) {
  return {
    sourceLabel: "Europe PMC",
    source: item.source || "",
    id: item.id || "",
    pmid:
      item.pmid ||
      (item.source === "MED"
        ? item.id
        : ""),
    pmcid: item.pmcid || "",
    doi: item.doi || "",
    title: cleanText(item.title, 700),
    journal: cleanText(
      item.journalTitle ||
        item.journalInfo?.journal?.title,
      300
    ),
    year: item.pubYear || "",
    abstract: cleanText(
      item.abstractText,
      6000
    ),
    url: item.pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/`
      : item.doi
        ? `https://doi.org/${item.doi}`
        : "",
    isOpenAccess:
      String(
        item.isOpenAccess || ""
      ).toUpperCase() === "Y",
    hasFullText:
      String(
        item.hasFullText || ""
      ).toUpperCase() === "Y",
    openAccessFullTextFound: false,
    fullTextSnippet: "",
    fullTextUrl: ""
  };
}

async function searchEuropePMC(query) {
  if (!query) {
    return [];
  }

  const params = new URLSearchParams({
    query,
    format: "json",
    pageSize: "10",
    resultType: "core"
  });

  const url =
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?` +
    params.toString();

  const data = await fetchJson(url);

  return arr(
    data.resultList?.result
  ).map(parseEuropeArticle);
}

async function fetchEuropeFullText(article) {
  const candidates = [];

  if (article.pmcid) {
    const pmcid = String(
      article.pmcid
    ).replace(/^PMC/i, "PMC");

    candidates.push(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(
        pmcid
      )}/fullTextXML`
    );
  }

  if (article.source && article.id) {
    candidates.push(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(
        article.source
      )}/${encodeURIComponent(
        article.id
      )}/fullTextXML`
    );
  }

  if (article.pmid) {
    candidates.push(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/MED/${encodeURIComponent(
        article.pmid
      )}/fullTextXML`
    );
  }

  for (const url of [
    ...new Set(candidates)
  ]) {
    try {
      const xml = await fetchText(url);

      const text = stripXmlToText(
        xml,
        9000
      );

      if (text.length > 500) {
        return {
          fullTextSnippet: text,
          fullTextUrl: url
        };
      }
    } catch (_) {
      // Try the next source.
    }
  }

  return {
    fullTextSnippet: "",
    fullTextUrl: ""
  };
}

// Combine and rank literature

function articleKey(article) {
  if (article.pmid) {
    return `pmid:${String(
      article.pmid
    ).toLowerCase()}`;
  }

  if (article.pmcid) {
    return `pmcid:${String(
      article.pmcid
    ).toLowerCase()}`;
  }

  if (article.doi) {
    return `doi:${String(
      article.doi
    ).toLowerCase()}`;
  }

  return `title:${String(
    article.title || ""
  )
    .toLowerCase()
    .slice(0, 160)}`;
}

function mergeArticles(...groups) {
  const map = new Map();

  for (const group of groups) {
    for (const article of group) {
      const key = articleKey(article);

      if (!key || key === "title:") {
        continue;
      }

      const existing =
        map.get(key) || {};

      map.set(key, {
        ...existing,
        ...article,
        title:
          article.title ||
          existing.title ||
          "",
        abstract:
          article.abstract ||
          existing.abstract ||
          "",
        pmid:
          article.pmid ||
          existing.pmid ||
          "",
        pmcid:
          article.pmcid ||
          existing.pmcid ||
          "",
        doi:
          article.doi ||
          existing.doi ||
          "",
        journal:
          article.journal ||
          existing.journal ||
          "",
        year:
          article.year ||
          existing.year ||
          "",
        url:
          article.url ||
          existing.url ||
          "",
        isOpenAccess: Boolean(
          article.isOpenAccess ||
            existing.isOpenAccess
        ),
        hasFullText: Boolean(
          article.hasFullText ||
            existing.hasFullText
        )
      });
    }
  }

  return [...map.values()];
}

function scoreArticle(article, trial) {
  const haystack =
    `${article.title || ""} ` +
    `${article.abstract || ""}`;

  const searchText =
    haystack.toLowerCase();

  let score = 0;

  if (
    trial.nctId &&
    searchText.includes(
      trial.nctId.toLowerCase()
    )
  ) {
    score += 100;
  }

  if (article.abstract) {
    score += 8;
  }

  if (
    article.pmcid ||
    article.isOpenAccess
  ) {
    score += 5;
  }

  const tokens = new Set([
    ...titleTokens(trial.briefTitle),
    ...titleTokens(trial.officialTitle)
  ]);

  for (const token of tokens) {
    if (searchText.includes(token)) {
      score += 2;
    }
  }

  return score;
}

function buildLiteratureContext(articles) {
  if (!articles.length) {
    return (
      "## LITERATURE SEARCH\n" +
      "No related PubMed abstract or legal open-access full-text source was found automatically."
    );
  }

  const blocks = articles.map(
    (article, index) => {
      const lines = [];

      lines.push(
        `### ARTICLE ${index + 1}`
      );

      lines.push(
        `Source: ${
          article.sourceLabel ||
          "Literature"
        }`
      );

      if (article.title) {
        lines.push(
          `Title: ${article.title}`
        );
      }

      if (article.pmid) {
        lines.push(
          `PMID: ${article.pmid}`
        );
      }

      if (article.pmcid) {
        lines.push(
          `PMCID: ${article.pmcid}`
        );
      }

      if (article.doi) {
        lines.push(
          `DOI: ${article.doi}`
        );
      }

      if (
        article.journal ||
        article.year
      ) {
        lines.push(
          `Journal/year: ${[
            article.journal,
            article.year
          ]
            .filter(Boolean)
            .join(" / ")}`
        );
      }

      if (article.abstract) {
        lines.push(
          `Abstract: ${article.abstract}`
        );
      }

      if (article.fullTextSnippet) {
        lines.push(
          `Legal open-access full-text snippet: ${article.fullTextSnippet}`
        );
      } else {
        lines.push(
          "Full text: Not retrieved through a legal open-access endpoint. Do not claim to have read paywalled full text."
        );
      }

      return lines.join("\n");
    }
  );

  return (
    "## LITERATURE SEARCH\n" +
    blocks.join("\n\n")
  );
}

// Related literature API

app.post(
  "/api/literature",
  async (req, res) => {
    try {
      const {
        nctId = "",
        briefTitle = "",
        officialTitle = ""
      } = req.body || {};

      const trial = {
        nctId: cleanText(
          nctId,
          30
        ),
        briefTitle: cleanText(
          briefTitle,
          700
        ),
        officialTitle: cleanText(
          officialTitle,
          1000
        )
      };

      if (
        !trial.nctId &&
        !trial.briefTitle &&
        !trial.officialTitle
      ) {
        return res
          .status(400)
          .json({
            error: {
              message:
                "Missing nctId, briefTitle, or officialTitle."
            }
          });
      }

      const pubMedQuery =
        buildPubMedQuery(trial);

      const europeQuery =
        buildEuropeQuery(trial);

      const [
        pubmedSearchResult,
        europeSearchResult
      ] =
        await Promise.allSettled([
          searchPubMed(pubMedQuery),
          searchEuropePMC(
            europeQuery
          )
        ]);

      const pubmedIds =
        pubmedSearchResult.status ===
        "fulfilled"
          ? pubmedSearchResult.value
          : [];

      const europeArticles =
        europeSearchResult.status ===
        "fulfilled"
          ? europeSearchResult.value
          : [];

      let pubmedArticles = [];

      if (pubmedIds.length) {
        try {
          pubmedArticles =
            await fetchPubMedArticles(
              pubmedIds
            );
        } catch (_) {
          pubmedArticles = [];
        }
      }

      let articles = mergeArticles(
        pubmedArticles,
        europeArticles
      )
        .map((article) => ({
          ...article,
          relevanceScore:
            scoreArticle(
              article,
              trial
            )
        }))
        .sort(
          (a, b) =>
            b.relevanceScore -
            a.relevanceScore
        )
        .slice(0, 8);

      articles =
        await Promise.all(
          articles.map(
            async (article) => {
              const shouldTryFullText =
                Boolean(
                  article.pmcid ||
                    article.isOpenAccess ||
                    article.hasFullText ||
                    article.source ===
                      "PMC"
                );

              if (
                !shouldTryFullText
              ) {
                return article;
              }

              const fullText =
                await fetchEuropeFullText(
                  article
                );

              return {
                ...article,
                openAccessFullTextFound:
                  Boolean(
                    fullText.fullTextSnippet
                  ),
                fullTextSnippet:
                  fullText.fullTextSnippet,
                fullTextUrl:
                  fullText.fullTextUrl
              };
            }
          )
        );

      res.json({
        articles: articles.map(
          (article) => ({
            sourceLabel:
              article.sourceLabel,
            pmid: article.pmid,
            pmcid: article.pmcid,
            doi: article.doi,
            title: article.title,
            journal:
              article.journal,
            year: article.year,
            abstract:
              article.abstract,
            url: article.url,
            relevanceScore:
              article.relevanceScore,
            openAccessFullTextFound:
              article.openAccessFullTextFound,
            fullTextPreview:
              cleanText(
                article.fullTextSnippet,
                1800
              )
          })
        ),
        context:
          buildLiteratureContext(
            articles
          )
      });
    } catch (error) {
      res.status(500).json({
        error: {
          message:
            `Could not retrieve PubMed/open-access literature: ${error.message}`
        }
      });
    }
  }
);

// PDF extraction

async function extractPdfText(
  pdfBuffer,
  maxChars = 45000
) {
  if (
    !pdfBuffer ||
    !pdfBuffer.length
  ) {
    return {
      text: "",
      pages: 0
    };
  }

  const pdfjs = await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  );

  const loadingTask =
    pdfjs.getDocument({
      data: new Uint8Array(
        pdfBuffer
      ),
      disableWorker: true,
      useSystemFonts: true
    });

  const pdf =
    await loadingTask.promise;

  const pageBlocks = [];

  let totalChars = 0;

  for (
    let pageNumber = 1;
    pageNumber <= pdf.numPages;
    pageNumber += 1
  ) {
    const page =
      await pdf.getPage(
        pageNumber
      );

    const content =
      await page.getTextContent();

    const parts = (
      content.items || []
    )
      .filter(
        (item) =>
          item &&
          typeof item.str ===
            "string"
      )
      .map((item) =>
        item.str.trim()
      )
      .filter(Boolean);

    const pageText = parts
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (pageText) {
      const block =
        `--- PDF PAGE ${pageNumber} ---\n` +
        pageText;

      pageBlocks.push(block);

      totalChars +=
        block.length;
    }

    if (
      totalChars >= maxChars
    ) {
      break;
    }
  }

  return {
    text: cleanText(
      pageBlocks.join(
        "\n\n"
      ),
      maxChars
    ),
    pages: pdf.numPages
  };
}

async function downloadZoteroAttachmentFile(
  userId,
  attachmentKey
) {
  const url =
    `${ZOTERO_API_BASE}/users/${encodeURIComponent(
      userId
    )}` +
    `/items/${encodeURIComponent(
      attachmentKey
    )}/file`;

  const response = await fetch(
    url,
    {
      headers: {
        "Zotero-API-Version":
          "3",
        "Zotero-API-Key":
          ZOTERO_API_KEY,
        accept:
          "application/pdf,application/octet-stream,*/*"
      },
      redirect: "follow"
    }
  );

  if (!response.ok) {
    const body =
      await response
        .text()
        .catch(() => "");

    throw new Error(
      `Zotero PDF download failed (${response.status})` +
        (body
          ? `: ${body.slice(
              0,
              250
            )}`
          : "")
    );
  }

  const contentType = String(
    response.headers.get(
      "content-type"
    ) || ""
  ).toLowerCase();

  const arrayBuffer =
    await response.arrayBuffer();

  const buffer =
    Buffer.from(arrayBuffer);

  const looksLikePdf =
    contentType.includes("pdf") ||
    buffer
      .subarray(0, 5)
      .toString("ascii") ===
      "%PDF-";

  if (!looksLikePdf) {
    throw new Error(
      "The Zotero attachment downloaded, but it was not a PDF."
    );
  }

  return buffer;
}

async function retrieveZoteroPdfText({
  userId,
  attachment
}) {
  if (!attachment?.key) {
    return {
      text: "",
      source: "none",
      pages: 0,
      indexedPages: null,
      totalPages: null,
      reason:
        "No PDF attachment was found for this Zotero item."
    };
  }

  try {
    const fullTextMeta =
      await zoteroFetchJson(
        `/users/${encodeURIComponent(
          userId
        )}/items/${encodeURIComponent(
          attachment.key
        )}/fulltext`
      );

    const indexedText =
      cleanText(
        fullTextMeta?.content ||
          "",
        45000
      );

    if (
      indexedText.length >= 300
    ) {
      return {
        text: indexedText,
        source:
          "zotero-indexed",
        pages: Number(
          fullTextMeta?.totalPages ||
            fullTextMeta?.indexedPages ||
            0
        ),
        indexedPages:
          fullTextMeta?.indexedPages ||
          null,
        totalPages:
          fullTextMeta?.totalPages ||
          null,
        reason: ""
      };
    }
  } catch (_) {
    // Zotero may not have indexed the attachment.
  }

  try {
    const pdfBuffer =
      await downloadZoteroAttachmentFile(
        userId,
        attachment.key
      );

    const parsed =
      await extractPdfText(
        pdfBuffer,
        45000
      );

    if (
      parsed.text.length >= 300
    ) {
      return {
        text: parsed.text,
        source: "zotero-pdf",
        pages: parsed.pages,
        indexedPages: null,
        totalPages:
          parsed.pages,
        reason: ""
      };
    }

    return {
      text: "",
      source:
        "zotero-pdf-no-text",
      pages: parsed.pages,
      indexedPages: null,
      totalPages:
        parsed.pages,
      reason:
        "The attached PDF was downloaded, but little or no selectable text could be extracted. It may be scanned/image-based."
    };
  } catch (error) {
    return {
      text: "",
      source:
        "download-failed",
      pages: 0,
      indexedPages: null,
      totalPages: null,
      reason: String(
        error.message ||
          error
      )
    };
  }
}

// Zotero

function zoteroHeaders() {
  return {
    accept: "application/json",
    "Zotero-API-Version": "3",
    "Zotero-API-Key":
      ZOTERO_API_KEY
  };
}

async function zoteroFetchJson(
  pathname
) {
  if (!ZOTERO_USER_ID) {
    throw new Error(
      "Missing ZOTERO_USER_ID."
    );
  }

  if (!ZOTERO_API_KEY) {
    throw new Error(
      "Missing ZOTERO_API_KEY. Add it to Render environment variables or your local .env file."
    );
  }

  const response = await fetch(
    `${ZOTERO_API_BASE}${pathname}`,
    {
      headers:
        zoteroHeaders()
    }
  );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Zotero request failed (${response.status}): ${text.slice(
        0,
        300
      )}`
    );
  }

  return text
    ? JSON.parse(text)
    : null;
}

function zoteroCreators(
  creators = []
) {
  return arr(creators)
    .map((creator) => {
      if (!creator) {
        return "";
      }

      if (creator.name) {
        return cleanText(
          creator.name,
          200
        );
      }

      return cleanText(
        [
          creator.firstName,
          creator.lastName
        ]
          .filter(Boolean)
          .join(" "),
        200
      );
    })
    .filter(Boolean)
    .join(", ");
}

function stripSimpleHtml(
  value = ""
) {
  return cleanText(
    String(value || "")
      .replace(
        /<br\s*\/?>/gi,
        "\n"
      )
      .replace(
        /<\/p>/gi,
        "\n"
      )
      .replace(
        /<[^>]+>/g,
        " "
      ),
    12000
  );
}

function normalizeZoteroItem(
  item
) {
  const data =
    item?.data || {};

  return {
    key:
      item?.key ||
      data.key ||
      "",
    version:
      item?.version ||
      data.version ||
      0,
    itemType:
      data.itemType || "",
    title: cleanText(
      data.title ||
        "(Untitled)",
      1200
    ),
    creators:
      zoteroCreators(
        data.creators || []
      ),
    date: cleanText(
      data.date || "",
      100
    ),
    publicationTitle:
      cleanText(
        data.publicationTitle ||
          data.bookTitle ||
          data.proceedingsTitle ||
          "",
        500
      ),
    volume: cleanText(
      data.volume || "",
      50
    ),
    issue: cleanText(
      data.issue || "",
      50
    ),
    pages: cleanText(
      data.pages || "",
      100
    ),
    DOI: cleanText(
      data.DOI || "",
      300
    ),
    url: cleanText(
      data.url || "",
      1200
    ),
    abstractNote:
      stripSimpleHtml(
        data.abstractNote || ""
      ),
    tags: arr(
      data.tags
    )
      .map((tag) =>
        cleanText(
          tag?.tag || tag,
          150
        )
      )
      .filter(Boolean)
      .slice(0, 30),
    dateModified:
      data.dateModified || "",
    parentItem:
      data.parentItem || ""
  };
}

function buildZoteroArticleContext({
  item,
  notes = [],
  attachment = null,
  fullText = "",
  fullTextSource = "none"
}) {
  const article =
    normalizeZoteroItem(item);

  const lines = [
    "## USER-SELECTED ZOTERO ARTICLE",
    `Zotero item key: ${article.key}`,
    `Item type: ${
      article.itemType ||
      "Not reported"
    }`,
    `Title: ${
      article.title ||
      "Not reported"
    }`,
    `Authors/creators: ${
      article.creators ||
      "Not reported"
    }`,
    `Date: ${
      article.date ||
      "Not reported"
    }`,
    `Journal/publication: ${
      article.publicationTitle ||
      "Not reported"
    }`,
    `DOI: ${
      article.DOI ||
      "Not reported"
    }`,
    `URL: ${
      article.url ||
      "Not reported"
    }`
  ];

  if (article.abstractNote) {
    lines.push(
      `Abstract: ${article.abstractNote}`
    );
  } else {
    lines.push(
      "Abstract: Not available in the Zotero item."
    );
  }

  if (article.tags.length) {
    lines.push(
      `Tags: ${article.tags.join(
        ", "
      )}`
    );
  }

  const noteTexts = notes
    .map(
      (note, index) => {
        const text =
          stripSimpleHtml(
            note?.data?.note ||
              ""
          );

        return text
          ? `Note ${
              index + 1
            }: ${text}`
          : "";
      }
    )
    .filter(Boolean);

  if (noteTexts.length) {
    lines.push(
      `Zotero notes:\n${noteTexts.join(
        "\n"
      )}`
    );
  }

  if (attachment) {
    const attachmentData =
      attachment?.data || {};

    lines.push(
      `Attachment: ${cleanText(
        attachmentData.title ||
          attachmentData.filename ||
          "Attached file",
        500
      )}`
    );
  }

  if (fullText) {
    let sourceLabel =
      "PDF/full-text evidence";

    if (
      fullTextSource ===
      "zotero-indexed"
    ) {
      sourceLabel =
        "Zotero indexed full text";
    }

    if (
      fullTextSource ===
      "zotero-pdf"
    ) {
      sourceLabel =
        "Text extracted from the actual PDF attached in Zotero";
    }

    if (
      fullTextSource ===
      "manual-upload"
    ) {
      sourceLabel =
        "Text extracted from a manually uploaded PDF";
    }

    lines.push(
      `${sourceLabel}:\n${cleanText(
        fullText,
        45000
      )}`
    );
  } else {
    lines.push(
      "Full text: Not retrieved. Answer only from the metadata, abstract, and notes above."
    );
  }

  return lines.join("\n");
}

// Zotero routes

app.get(
  "/api/zotero/library",
  async (req, res) => {
    try {
      const q = cleanText(
        req.query.q || "",
        300
      ).toLowerCase();

      const params =
        new URLSearchParams({
          limit: "100",
          sort: "dateModified",
          direction: "desc",
          format: "json"
        });

      const rawItems =
        await zoteroFetchJson(
          `/users/${encodeURIComponent(
            ZOTERO_USER_ID
          )}/items/top?${params.toString()}`
        );

      const excludedTypes =
        new Set([
          "attachment",
          "note",
          "annotation"
        ]);

      let items = arr(rawItems)
        .map(
          normalizeZoteroItem
        )
        .filter(
          (item) =>
            item.key &&
            !excludedTypes.has(
              item.itemType
            )
        );

      if (q) {
        items = items.filter(
          (item) => {
            const haystack = [
              item.title,
              item.creators,
              item.publicationTitle,
              item.DOI,
              item.tags.join(" ")
            ]
              .join(" ")
              .toLowerCase();

            return haystack.includes(
              q
            );
          }
        );
      }

      res.json({
        userId:
          ZOTERO_USER_ID,
        username: "",
        count: items.length,
        items
      });
    } catch (error) {
      res.status(500).json({
        error: {
          message:
            `Could not load Zotero library: ${error.message}`
        }
      });
    }
  }
);

app.get(
  "/api/zotero/article/:itemKey",
  async (req, res) => {
    try {
      const itemKey =
        cleanText(
          req.params.itemKey ||
            "",
          40
        );

      if (
        !/^[A-Za-z0-9]+$/.test(
          itemKey
        )
      ) {
        return res
          .status(400)
          .json({
            error: {
              message:
                "Invalid Zotero item key."
            }
          });
      }

      const item =
        await zoteroFetchJson(
          `/users/${encodeURIComponent(
            ZOTERO_USER_ID
          )}/items/${encodeURIComponent(
            itemKey
          )}`
        );

      let children = [];

      try {
        children =
          await zoteroFetchJson(
            `/users/${encodeURIComponent(
              ZOTERO_USER_ID
            )}/items/${encodeURIComponent(
              itemKey
            )}/children?limit=100&format=json`
          );
      } catch (_) {
        children = [];
      }

      const notes = arr(
        children
      ).filter(
        (child) =>
          child?.data
            ?.itemType ===
          "note"
      );

      const attachments = arr(
        children
      ).filter(
        (child) =>
          child?.data
            ?.itemType ===
          "attachment"
      );

      const pdfAttachment =
        attachments.find(
          (attachment) =>
            /pdf/i.test(
              `${
                attachment?.data
                  ?.contentType ||
                ""
              } ${
                attachment?.data
                  ?.filename ||
                ""
              } ${
                attachment?.data
                  ?.title ||
                ""
              }`
            )
        ) ||
        attachments[0] ||
        null;

      const pdfResult =
        await retrieveZoteroPdfText(
          {
            userId:
              ZOTERO_USER_ID,
            attachment:
              pdfAttachment
          }
        );

      const fullText =
        pdfResult.text || "";

      const normalized =
        normalizeZoteroItem(
          item
        );

      const context =
        buildZoteroArticleContext({
          item,
          notes,
          attachment:
            pdfAttachment,
          fullText,
          fullTextSource:
            pdfResult.source
        });

      res.json({
        article: normalized,
        attachment:
          pdfAttachment
            ? {
                key:
                  pdfAttachment.key,
                title: cleanText(
                  pdfAttachment
                    ?.data
                    ?.title ||
                    pdfAttachment
                      ?.data
                      ?.filename ||
                    "Attachment",
                  500
                ),
                filename:
                  cleanText(
                    pdfAttachment
                      ?.data
                      ?.filename ||
                      "",
                    500
                  ),
                contentType:
                  cleanText(
                    pdfAttachment
                      ?.data
                      ?.contentType ||
                      "",
                    200
                  )
              }
            : null,
        fullTextAvailable:
          Boolean(fullText),
        fullTextSource:
          pdfResult.source,
        pdfStatusMessage:
          pdfResult.reason ||
          "",
        indexedPages:
          pdfResult.indexedPages ||
          null,
        totalPages:
          pdfResult.totalPages ||
          pdfResult.pages ||
          null,
        context
      });
    } catch (error) {
      res.status(500).json({
        error: {
          message:
            `Could not load Zotero article: ${error.message}`
        }
      });
    }
  }
);

// Manual PDF upload fallback

app.post(
  "/api/zotero/pdf-upload",
  express.raw({
    type: [
      "application/pdf",
      "application/octet-stream"
    ],
    limit: "30mb"
  }),
  async (req, res) => {
    try {
      if (
        !Buffer.isBuffer(
          req.body
        ) ||
        req.body.length < 5
      ) {
        return res
          .status(400)
          .json({
            error: {
              message:
                "No PDF file was received."
            }
          });
      }

      if (
        req.body
          .subarray(0, 5)
          .toString(
            "ascii"
          ) !== "%PDF-"
      ) {
        return res
          .status(400)
          .json({
            error: {
              message:
                "The uploaded file does not appear to be a PDF."
            }
          });
      }

      const parsed =
        await extractPdfText(
          req.body,
          45000
        );

      if (
        !parsed.text ||
        parsed.text.length < 300
      ) {
        return res
          .status(422)
          .json({
            error: {
              message:
                "The PDF was received, but little or no selectable text could be extracted. It may be scanned/image-only and would require OCR."
            }
          });
      }

      res.json({
        ok: true,
        pages: parsed.pages,
        text: parsed.text,
        source:
          "manual-upload"
      });
    } catch (error) {
      console.error(
        "Manual PDF parse error:",
        error
      );

      res.status(500).json({
        error: {
          message:
            `Could not read PDF: ${error.message}`
        }
      });
    }
  }
);

// Claude chat

app.post(
  "/api/chat",
  async (req, res) => {
    try {
      if (
        !ANTHROPIC_API_KEY
      ) {
        return res
          .status(500)
          .json({
            error: {
              message:
                "Missing ANTHROPIC_API_KEY. Add it to your local .env file or Render environment variables."
            }
          });
      }

      const {
        system,
        messages
      } = req.body || {};

      if (
        typeof system !==
          "string" ||
        !system.trim() ||
        !Array.isArray(messages)
      ) {
        return res
          .status(400)
          .json({
            error: {
              message:
                "Request must include a system string and messages array."
            }
          });
      }

      if (
        messages.length > 40
      ) {
        return res
          .status(400)
          .json({
            error: {
              message:
                "The chat history is too long. Start a new trial chat and try again."
            }
          });
      }

      const anthropicResponse =
        await fetch(
          "https://api.anthropic.com/v1/messages",
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json",
              "anthropic-version":
                "2023-06-01",
              "x-api-key":
                ANTHROPIC_API_KEY
            },
            body: JSON.stringify({
              model:
                ANTHROPIC_MODEL,
              max_tokens: 2600,
              thinking: {
                type:
                  "disabled"
              },
              system,
              messages
            })
          }
        );

      const responseText =
        await anthropicResponse.text();

      res
        .status(
          anthropicResponse.status
        )
        .type(
          "application/json"
        )
        .send(responseText);
    } catch (error) {
      res.status(500).json({
        error: {
          message:
            `Server could not reach Anthropic: ${error.message}`
        }
      });
    }
  }
);

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      ok: true,
      model:
        ANTHROPIC_MODEL,
      zoteroConfigured:
        Boolean(
          ZOTERO_USER_ID &&
            ZOTERO_API_KEY
        )
    });
  }
);

app.listen(PORT, () => {
  console.log(
    `Clinical Trial Evidence Assistant running at http://localhost:${PORT}`
  );
});
