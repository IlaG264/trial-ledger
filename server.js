/*
  Clinical Trial Evidence Assistant — BACKEND
  ------------------------------------------------------------
  This file runs on the server (Render or your own computer).

  Main jobs:
  1) Serve the frontend from /public.
  2) Search PubMed and Europe PMC for related papers.
  3) Retrieve legal open-access full text when Europe PMC provides it.
  4) Keep the Anthropic API key hidden.
  5) Send evidence-grounded questions to Claude.
*/

import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { XMLParser } from "fast-xml-parser";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Private server-side settings. Never place ANTHROPIC_API_KEY in index.html.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const NCBI_EMAIL = process.env.NCBI_EMAIL || "";
const NCBI_API_KEY = process.env.NCBI_API_KEY || "";

// ES modules do not create __dirname automatically, so we recreate it here.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PubMed article records are returned as XML. This parser turns XML into JS objects.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text"
});

// trialContext can be large when a study has posted results.
app.use(express.json({ limit: "20mb" }));

// Serve public/index.html and other frontend files.
app.use(express.static(path.join(__dirname, "public")));

/* -------------------------------------------------------------------------- */
/* Small helper functions                                                     */
/* -------------------------------------------------------------------------- */

// Guarantee that a value is an array. XML parsers sometimes return one object
// for one item and an array for multiple items.
function arr(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// Pull readable text out of strings, numbers, arrays, and parsed XML objects.
function textOf(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(" ");

  if (typeof value === "object") {
    if (value["#text"] !== undefined) return textOf(value["#text"]);
    return Object.values(value).map(textOf).filter(Boolean).join(" ");
  }

  return "";
}

// Normalize spaces and place a safe character limit on long evidence text.
function cleanText(text, maxLen = 6000) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .trim()
    .slice(0, maxLen);
}

// Convert Europe PMC full-text XML into readable text. This intentionally
// removes references and tables to keep the prompt useful and reasonably sized.
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

// Split a title into useful words for a simple relevance score.
function titleTokens(text) {
  const stopWords = new Set([
    "the", "and", "for", "with", "from", "into", "that", "this", "study",
    "trial", "randomized", "clinical", "comparison", "compared", "versus"
  ]);

  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopWords.has(word));
}

/* -------------------------------------------------------------------------- */
/* Build search queries                                                       */
/* -------------------------------------------------------------------------- */

function buildPubMedQuery({ nctId, briefTitle, officialTitle }) {
  const parts = [];

  if (nctId) parts.push(`${nctId}[All Fields]`);
  if (briefTitle) parts.push(`"${briefTitle}"[Title/Abstract]`);
  if (officialTitle && officialTitle !== briefTitle) {
    parts.push(`"${officialTitle}"[Title/Abstract]`);
  }

  return parts.join(" OR ") || briefTitle || officialTitle || nctId;
}

function buildEuropeQuery({ nctId, briefTitle, officialTitle }) {
  const parts = [];

  if (nctId) parts.push(`"${nctId}"`);
  if (briefTitle) parts.push(`"${briefTitle}"`);
  if (officialTitle && officialTitle !== briefTitle) parts.push(`"${officialTitle}"`);

  return parts.join(" OR ") || briefTitle || officialTitle || nctId;
}

// NCBI recommends identifying the tool and optionally supplying an email/API key.
function ncbiParams() {
  const params = new URLSearchParams({
    tool: "clinical-trial-evidence-assistant"
  });

  if (NCBI_EMAIL) params.set("email", NCBI_EMAIL);
  if (NCBI_API_KEY) params.set("api_key", NCBI_API_KEY);

  return params;
}

/* -------------------------------------------------------------------------- */
/* Network helpers                                                            */
/* -------------------------------------------------------------------------- */

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { accept: "application/xml,text/xml,text/plain,*/*" }
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.text();
}

/* -------------------------------------------------------------------------- */
/* PubMed                                                                     */
/* -------------------------------------------------------------------------- */

// First search PubMed for article IDs.
async function searchPubMed(query) {
  if (!query) return [];

  const params = ncbiParams();
  params.set("db", "pubmed");
  params.set("term", query);
  params.set("retmode", "json");
  params.set("retmax", "10");
  params.set("sort", "relevance");

  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params.toString()}`;
  const data = await fetchJson(url);

  return data.esearchresult?.idlist || [];
}

// Turn one parsed PubMed XML article into a clean object used by the app.
function parsePubMedArticle(article) {
  const med = article.MedlineCitation || {};
  const pub = article.PubmedData || {};
  const art = med.Article || {};
  const journal = art.Journal || {};
  const pubDate = journal.JournalIssue?.PubDate || {};
  const ids = arr(pub.ArticleIdList?.ArticleId);

  const idByType = (type) => {
    const found = ids.find(
      (item) => String(item?.["@_IdType"] || "").toLowerCase() === type.toLowerCase()
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
    title: cleanText(textOf(art.ArticleTitle), 700),
    journal: cleanText(textOf(journal.Title), 300),
    year: textOf(pubDate.Year) || textOf(pubDate.MedlineDate).slice(0, 4),
    abstract: cleanText(textOf(art.Abstract?.AbstractText), 6000),
    url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
    isOpenAccess: false,
    hasFullText: false,
    openAccessFullTextFound: false,
    fullTextSnippet: "",
    fullTextUrl: ""
  };
}

// Use EFetch to retrieve complete PubMed article metadata/abstracts for the IDs.
async function fetchPubMedArticles(ids) {
  if (!ids.length) return [];

  const params = ncbiParams();
  params.set("db", "pubmed");
  params.set("id", ids.join(","));
  params.set("retmode", "xml");

  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${params.toString()}`;
  const xml = await fetchText(url);
  const parsed = xmlParser.parse(xml);

  return arr(parsed.PubmedArticleSet?.PubmedArticle)
    .map(parsePubMedArticle)
    .filter((article) => article.title || article.abstract || article.pmid);
}

/* -------------------------------------------------------------------------- */
/* Europe PMC                                                                 */
/* -------------------------------------------------------------------------- */

function parseEuropeArticle(item) {
  return {
    sourceLabel: "Europe PMC",
    source: item.source || "",
    id: item.id || "",
    pmid: item.pmid || (item.source === "MED" ? item.id : ""),
    pmcid: item.pmcid || "",
    doi: item.doi || "",
    title: cleanText(item.title, 700),
    journal: cleanText(item.journalTitle || item.journalInfo?.journal?.title, 300),
    year: item.pubYear || "",
    abstract: cleanText(item.abstractText, 6000),
    url: item.pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/`
      : (item.doi ? `https://doi.org/${item.doi}` : ""),
    isOpenAccess: String(item.isOpenAccess || "").toUpperCase() === "Y",
    hasFullText: String(item.hasFullText || "").toUpperCase() === "Y",
    openAccessFullTextFound: false,
    fullTextSnippet: "",
    fullTextUrl: ""
  };
}

async function searchEuropePMC(query) {
  if (!query) return [];

  const params = new URLSearchParams({
    query,
    format: "json",
    pageSize: "10",
    resultType: "core"
  });

  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`;
  const data = await fetchJson(url);

  return arr(data.resultList?.result).map(parseEuropeArticle);
}

// Only official Europe PMC full-text endpoints are tried. This does not bypass paywalls.
async function fetchEuropeFullText(article) {
  const candidates = [];

  if (article.pmcid) {
    const pmcid = String(article.pmcid).replace(/^PMC/i, "PMC");
    candidates.push(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(pmcid)}/fullTextXML`
    );
  }

  if (article.source && article.id) {
    candidates.push(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(article.source)}/${encodeURIComponent(article.id)}/fullTextXML`
    );
  }

  if (article.pmid) {
    candidates.push(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/MED/${encodeURIComponent(article.pmid)}/fullTextXML`
    );
  }

  for (const url of [...new Set(candidates)]) {
    try {
      const xml = await fetchText(url);
      const text = stripXmlToText(xml, 9000);

      if (text.length > 500) {
        return { fullTextSnippet: text, fullTextUrl: url };
      }
    } catch (_) {
      // If one official endpoint fails, try the next candidate.
    }
  }

  return { fullTextSnippet: "", fullTextUrl: "" };
}

/* -------------------------------------------------------------------------- */
/* Combine and rank literature                                                */
/* -------------------------------------------------------------------------- */

function articleKey(article) {
  if (article.pmid) return `pmid:${String(article.pmid).toLowerCase()}`;
  if (article.pmcid) return `pmcid:${String(article.pmcid).toLowerCase()}`;
  if (article.doi) return `doi:${String(article.doi).toLowerCase()}`;
  return `title:${String(article.title || "").toLowerCase().slice(0, 160)}`;
}

function mergeArticles(...groups) {
  const map = new Map();

  for (const group of groups) {
    for (const article of group) {
      const key = articleKey(article);
      if (!key || key === "title:") continue;

      const existing = map.get(key) || {};

      // Preserve useful fields from either database instead of losing them.
      map.set(key, {
        ...existing,
        ...article,
        title: article.title || existing.title || "",
        abstract: article.abstract || existing.abstract || "",
        pmid: article.pmid || existing.pmid || "",
        pmcid: article.pmcid || existing.pmcid || "",
        doi: article.doi || existing.doi || "",
        journal: article.journal || existing.journal || "",
        year: article.year || existing.year || "",
        url: article.url || existing.url || "",
        isOpenAccess: Boolean(article.isOpenAccess || existing.isOpenAccess),
        hasFullText: Boolean(article.hasFullText || existing.hasFullText)
      });
    }
  }

  return [...map.values()];
}

// Rank likely trial-related papers above weaker title matches.
function scoreArticle(article, trial) {
  const haystack = `${article.title || ""} ${article.abstract || ""}`.toLowerCase();
  let score = 0;

  if (trial.nctId && haystack.includes(trial.nctId.toLowerCase())) score += 100;
  if (article.abstract) score += 8;
  if (article.pmcid || article.isOpenAccess) score += 5;

  const tokens = new Set([
    ...titleTokens(trial.briefTitle),
    ...titleTokens(trial.officialTitle)
  ]);

  for (const token of tokens) {
    if (haystack.includes(token)) score += 2;
  }

  return score;
}

function buildLiteratureContext(articles) {
  if (!articles.length) {
    return "## LITERATURE SEARCH\nNo related PubMed abstract or legal open-access full-text source was found automatically.";
  }

  const blocks = articles.map((article, index) => {
    const lines = [];

    lines.push(`### ARTICLE ${index + 1}`);
    lines.push(`Source: ${article.sourceLabel || "Literature"}`);
    if (article.title) lines.push(`Title: ${article.title}`);
    if (article.pmid) lines.push(`PMID: ${article.pmid}`);
    if (article.pmcid) lines.push(`PMCID: ${article.pmcid}`);
    if (article.doi) lines.push(`DOI: ${article.doi}`);
    if (article.journal || article.year) {
      lines.push(`Journal/year: ${[article.journal, article.year].filter(Boolean).join(" / ")}`);
    }
    if (article.abstract) lines.push(`Abstract: ${article.abstract}`);
    if (article.fullTextSnippet) {
      lines.push(`Legal open-access full-text snippet: ${article.fullTextSnippet}`);
    } else {
      lines.push(
        "Full text: Not retrieved through a legal open-access endpoint. Do not claim to have read paywalled full text."
      );
    }

    return lines.join("\n");
  });

  return `## LITERATURE SEARCH\n${blocks.join("\n\n")}`;
}

/* -------------------------------------------------------------------------- */
/* API: related literature                                                    */
/* -------------------------------------------------------------------------- */

app.post("/api/literature", async (req, res) => {
  try {
    const {
      nctId = "",
      briefTitle = "",
      officialTitle = ""
    } = req.body || {};

    const trial = {
      nctId: cleanText(nctId, 30),
      briefTitle: cleanText(briefTitle, 700),
      officialTitle: cleanText(officialTitle, 1000)
    };

    if (!trial.nctId && !trial.briefTitle && !trial.officialTitle) {
      return res.status(400).json({
        error: { message: "Missing nctId, briefTitle, or officialTitle." }
      });
    }

    const pubMedQuery = buildPubMedQuery(trial);
    const europeQuery = buildEuropeQuery(trial);

    // Search both databases. allSettled means one database can still work even
    // if the other one temporarily fails.
    const [pubmedSearchResult, europeSearchResult] = await Promise.allSettled([
      searchPubMed(pubMedQuery),
      searchEuropePMC(europeQuery)
    ]);

    const pubmedIds = pubmedSearchResult.status === "fulfilled"
      ? pubmedSearchResult.value
      : [];

    const europeArticles = europeSearchResult.status === "fulfilled"
      ? europeSearchResult.value
      : [];

    let pubmedArticles = [];
    if (pubmedIds.length) {
      try {
        pubmedArticles = await fetchPubMedArticles(pubmedIds);
      } catch (_) {
        pubmedArticles = [];
      }
    }

    let articles = mergeArticles(pubmedArticles, europeArticles)
      .map((article) => ({
        ...article,
        relevanceScore: scoreArticle(article, trial)
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 8);

    // Try full text only where the metadata suggests an official OA copy may exist.
    articles = await Promise.all(
      articles.map(async (article) => {
        const shouldTryFullText = Boolean(
          article.pmcid ||
          article.isOpenAccess ||
          article.hasFullText ||
          article.source === "PMC"
        );

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
      articles: articles.map((article) => ({
        sourceLabel: article.sourceLabel,
        pmid: article.pmid,
        pmcid: article.pmcid,
        doi: article.doi,
        title: article.title,
        journal: article.journal,
        year: article.year,
        abstract: article.abstract,
        url: article.url,
        relevanceScore: article.relevanceScore,
        openAccessFullTextFound: article.openAccessFullTextFound,
        fullTextPreview: cleanText(article.fullTextSnippet, 1800)
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

/* -------------------------------------------------------------------------- */
/* API: Claude chat                                                           */
/* -------------------------------------------------------------------------- */

app.post("/api/chat", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: {
          message: "Missing ANTHROPIC_API_KEY. Add it to your local .env file or Render environment variables."
        }
      });
    }

    const { system, messages } = req.body || {};

    if (typeof system !== "string" || !system.trim() || !Array.isArray(messages)) {
      return res.status(400).json({
        error: { message: "Request must include a system string and messages array." }
      });
    }

    if (messages.length > 40) {
      return res.status(400).json({
        error: { message: "The chat history is too long. Start a new trial chat and try again." }
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
        max_tokens: 2600,
        // Disabling adaptive thinking keeps this evidence-extraction chatbot
        // faster and reserves the output budget for the visible answer/table.
        thinking: { type: "disabled" },
        system,
        messages
      })
    });

    const responseText = await anthropicResponse.text();

    res
      .status(anthropicResponse.status)
      .type("application/json")
      .send(responseText);
  } catch (error) {
    res.status(500).json({
      error: { message: `Server could not reach Anthropic: ${error.message}` }
    });
  }
});

// Small route that helps you confirm the backend is alive.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: ANTHROPIC_MODEL });
});

app.listen(PORT, () => {
  console.log(`Clinical Trial Evidence Assistant running at http://localhost:${PORT}`);
});
