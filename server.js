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
const NCBI_EMAIL = process.env.NCBI_EMAIL || "";
const NCBI_API_KEY = process.env.NCBI_API_KEY || "";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text"
});

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

function arr(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (value["#text"]) return textOf(value["#text"]);
    return Object.values(value).map(textOf).filter(Boolean).join(" ");
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

function stripXmlToText(xml, maxLen = 7000) {
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

function buildLiteratureQuery({ nctId, briefTitle, officialTitle }) {
  const parts = [];
  if (nctId) parts.push(`${nctId}[All Fields]`);
  if (briefTitle) parts.push(`"${briefTitle}"[Title/Abstract]`);
  if (officialTitle && officialTitle !== briefTitle) parts.push(`"${officialTitle}"[Title/Abstract]`);
  return parts.join(" OR ") || briefTitle || officialTitle || nctId;
}

function buildEuropeQuery({ nctId, briefTitle, officialTitle }) {
  const parts = [];
  if (nctId) parts.push(`"${nctId}"`);
  if (briefTitle) parts.push(`"${briefTitle}"`);
  if (officialTitle && officialTitle !== briefTitle) parts.push(`"${officialTitle}"`);
  return parts.join(" OR ") || briefTitle || officialTitle || nctId;
}

function ncbiParams() {
  const params = new URLSearchParams({
    tool: "clinical-trial-evidence-assistant"
  });
  if (NCBI_EMAIL) params.set("email", NCBI_EMAIL);
  if (NCBI_API_KEY) params.set("api_key", NCBI_API_KEY);
  return params;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${url}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { accept: "application/xml,text/xml,text/plain,*/*" } });
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${url}`);
  return response.text();
}

async function searchPubMed(query) {
  if (!query) return [];
  const params = ncbiParams();
  params.set("db", "pubmed");
  params.set("term", query);
  params.set("retmode", "json");
  params.set("retmax", "8");
  params.set("sort", "relevance");

  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params.toString()}`;
  const data = await fetchJson(url);
  return data.esearchresult?.idlist || [];
}

function parsePubMedArticle(article) {
  const med = article.MedlineCitation || {};
  const pub = article.PubmedData || {};
  const art = med.Article || {};
  const journal = art.Journal || {};
  const pubDate = journal.JournalIssue?.PubDate || {};
  const ids = arr(pub.ArticleIdList?.ArticleId);

  const idByType = (type) => {
    const found = ids.find((x) => String(x?.["@_IdType"] || "").toLowerCase() === type.toLowerCase());
    return textOf(found);
  };

  return {
    sourceLabel: "PubMed",
    pmid: textOf(med.PMID),
    pmcid: idByType("pmc"),
    doi: idByType("doi"),
    title: cleanText(textOf(art.ArticleTitle), 500),
    journal: cleanText(textOf(journal.Title), 250),
    year: textOf(pubDate.Year) || textOf(pubDate.MedlineDate).slice(0, 4),
    abstract: cleanText(textOf(art.Abstract?.AbstractText), 3500),
    url: textOf(med.PMID) ? `https://pubmed.ncbi.nlm.nih.gov/${textOf(med.PMID)}/` : "",
    openAccessFullTextFound: false,
    fullTextSnippet: ""
  };
}

async function fetchPubMedArticles(ids) {
  if (!ids.length) return [];
  const params = ncbiParams();
  params.set("db", "pubmed");
  params.set("id", ids.join(","));
  params.set("retmode", "xml");

  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${params.toString()}`;
  const xml = await fetchText(url);
  const parsed = xmlParser.parse(xml);
  const articles = arr(parsed.PubmedArticleSet?.PubmedArticle).map(parsePubMedArticle);
  return articles.filter((a) => a.title || a.abstract || a.pmid);
}

function parseEuropeArticle(item) {
  return {
    sourceLabel: "Europe PMC",
    source: item.source || "",
    id: item.id || "",
    pmid: item.pmid || (item.source === "MED" ? item.id : ""),
    pmcid: item.pmcid || "",
    doi: item.doi || "",
    title: cleanText(item.title, 500),
    journal: cleanText(item.journalTitle || item.journalInfo?.journal?.title, 250),
    year: item.pubYear || "",
    abstract: cleanText(item.abstractText, 3500),
    url: item.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/` : (item.doi ? `https://doi.org/${item.doi}` : ""),
    isOpenAccess: String(item.isOpenAccess || "").toUpperCase() === "Y",
    hasFullText: String(item.hasFullText || "").toUpperCase() === "Y",
    openAccessFullTextFound: false,
    fullTextSnippet: ""
  };
}

async function searchEuropePMC(query) {
  if (!query) return [];
  const params = new URLSearchParams({
    query,
    format: "json",
    pageSize: "8",
    resultType: "core"
  });
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`;
  const data = await fetchJson(url);
  return arr(data.resultList?.result).map(parseEuropeArticle);
}

async function fetchEuropeFullText(article) {
  const candidates = [];

  if (article.pmcid) {
    candidates.push(`https://www.ebi.ac.uk/europepmc/webservices/rest/PMC/${encodeURIComponent(article.pmcid)}/fullTextXML`);
  }
  if (article.source && article.id) {
    candidates.push(`https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(article.source)}/${encodeURIComponent(article.id)}/fullTextXML`);
  }
  if (article.pmid) {
    candidates.push(`https://www.ebi.ac.uk/europepmc/webservices/rest/MED/${encodeURIComponent(article.pmid)}/fullTextXML`);
  }

  for (const url of [...new Set(candidates)]) {
    try {
      const xml = await fetchText(url);
      const text = stripXmlToText(xml, 7000);
      if (text && text.length > 500) {
        return { fullTextSnippet: text, fullTextUrl: url };
      }
    } catch (_) {
      // Try the next legal open-access endpoint candidate.
    }
  }

  return { fullTextSnippet: "", fullTextUrl: "" };
}

function articleKey(a) {
  if (a.pmid) return `pmid:${String(a.pmid).toLowerCase()}`;
  if (a.pmcid) return `pmcid:${String(a.pmcid).toLowerCase()}`;
  if (a.doi) return `doi:${String(a.doi).toLowerCase()}`;
  return `title:${String(a.title || "").toLowerCase().slice(0, 120)}`;
}

function mergeArticles(...groups) {
  const map = new Map();
  for (const group of groups) {
    for (const article of group) {
      const key = articleKey(article);
      if (!key || key === "title:") continue;
      const existing = map.get(key) || {};
      map.set(key, { ...existing, ...article, abstract: article.abstract || existing.abstract, title: article.title || existing.title });
    }
  }
  return [...map.values()].slice(0, 8);
}

function buildLiteratureContext(articles) {
  if (!articles.length) {
    return "## LITERATURE SEARCH\nNo PubMed abstract or legal open-access full-text source was found automatically.";
  }

  const blocks = articles.map((a, idx) => {
    const lines = [];
    lines.push(`### ARTICLE ${idx + 1}`);
    lines.push(`Source: ${a.sourceLabel || "Literature"}`);
    if (a.title) lines.push(`Title: ${a.title}`);
    if (a.pmid) lines.push(`PMID: ${a.pmid}`);
    if (a.pmcid) lines.push(`PMCID: ${a.pmcid}`);
    if (a.doi) lines.push(`DOI: ${a.doi}`);
    if (a.journal || a.year) lines.push(`Journal/year: ${[a.journal, a.year].filter(Boolean).join(" / ")}`);
    if (a.abstract) lines.push(`PubMed/Europe PMC abstract: ${a.abstract}`);
    if (a.fullTextSnippet) lines.push(`Legal open-access full-text snippet: ${a.fullTextSnippet}`);
    if (!a.fullTextSnippet) lines.push("Full text: Not found through a legal open-access endpoint; do not claim to have read the paywalled article.");
    return lines.join("\n");
  });

  return `## LITERATURE SEARCH\n${blocks.join("\n\n")}`;
}

app.post("/api/literature", async (req, res) => {
  try {
    const { nctId = "", briefTitle = "", officialTitle = "" } = req.body || {};
    const payload = { nctId, briefTitle, officialTitle };

    if (!nctId && !briefTitle && !officialTitle) {
      return res.status(400).json({ error: { message: "Missing nctId, briefTitle, or officialTitle." } });
    }

    const pubMedQuery = buildLiteratureQuery(payload);
    const europeQuery = buildEuropeQuery(payload);

    const pubmedIds = await searchPubMed(pubMedQuery);
    const pubmedArticles = await fetchPubMedArticles(pubmedIds);
    const europeArticles = await searchEuropePMC(europeQuery);
    let articles = mergeArticles(pubmedArticles, europeArticles);

    articles = await Promise.all(
      articles.map(async (article) => {
        const shouldTryFullText = article.pmcid || article.isOpenAccess || article.hasFullText || article.source === "PMC";
        if (!shouldTryFullText) return article;
        const fullText = await fetchEuropeFullText(article);
        return {
          ...article,
          openAccessFullTextFound: Boolean(fullText.fullTextSnippet),
          fullTextSnippet: fullText.fullTextSnippet,
          fullTextUrl: fullText.fullTextUrl
        };
      })
    );

    res.json({
      articles: articles.map((a) => ({
        sourceLabel: a.sourceLabel,
        pmid: a.pmid,
        pmcid: a.pmcid,
        doi: a.doi,
        title: a.title,
        journal: a.journal,
        year: a.year,
        url: a.url,
        openAccessFullTextFound: a.openAccessFullTextFound
      })),
      context: buildLiteratureContext(articles)
    });
  } catch (error) {
    res.status(500).json({
      error: {
        message: `Could not retrieve PubMed/open-access literature: ${error.message}`
      }
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: {
          message: "Missing ANTHROPIC_API_KEY. Create a .env file and add your key."
        }
      });
    }

    const { system, messages } = req.body || {};

    if (!system || !Array.isArray(messages)) {
      return res.status(400).json({
        error: {
          message: "Request must include system and messages."
        }
      });
    }

    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": ANTHROPIC_API_KEY
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1200,
        system,
        messages
      })
    });

    const text = await anthropicResponse.text();

    res
      .status(anthropicResponse.status)
      .type("application/json")
      .send(text);
  } catch (error) {
    res.status(500).json({
      error: {
        message: `Server could not reach Anthropic: ${error.message}`
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`Clinical Trial Evidence Assistant running at http://localhost:${PORT}`);
});
