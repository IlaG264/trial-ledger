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
import crypto from "crypto";
import OAuth from "oauth-1.0a";

dotenv.config();

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

// Private server-side settings. Never place ANTHROPIC_API_KEY in index.html.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const NCBI_EMAIL = process.env.NCBI_EMAIL || "";
const NCBI_API_KEY = process.env.NCBI_API_KEY || "";

// Zotero OAuth 1.0a application settings.
// Register one application with Zotero, then keep these values only in Render/.env.
// Individual users NEVER paste their Zotero API key into this app.
const ZOTERO_CLIENT_KEY = process.env.ZOTERO_CLIENT_KEY || "";
const ZOTERO_CLIENT_SECRET = process.env.ZOTERO_CLIENT_SECRET || "";
const APP_BASE_URL = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
const SESSION_SECRET = process.env.SESSION_SECRET || "";

const ZOTERO_API_BASE = "https://api.zotero.org";
const ZOTERO_OAUTH_REQUEST_URL = "https://www.zotero.org/oauth/request";
const ZOTERO_OAUTH_ACCESS_URL = "https://www.zotero.org/oauth/access";
const ZOTERO_OAUTH_AUTHORIZE_URL = "https://www.zotero.org/oauth/authorize";

const ZOTERO_AUTH_COOKIE = "ctea_zotero_auth";
const ZOTERO_OAUTH_STATE_COOKIE = "ctea_zotero_oauth_state";
const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60; // 10 minutes

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
/* Secure cookie + Zotero OAuth helpers                                       */
/* -------------------------------------------------------------------------- */

function requireOAuthConfig() {
  const missing = [];

  if (!ZOTERO_CLIENT_KEY) missing.push("ZOTERO_CLIENT_KEY");
  if (!ZOTERO_CLIENT_SECRET) missing.push("ZOTERO_CLIENT_SECRET");
  if (!SESSION_SECRET) missing.push("SESSION_SECRET");

  if (missing.length) {
    throw new Error(`Missing environment variable(s): ${missing.join(", ")}`);
  }
}

function getBaseUrl(req) {
  if (APP_BASE_URL) return APP_BASE_URL;

  // Convenient for local development. For Render, set APP_BASE_URL explicitly.
  return `${req.protocol}://${req.get("host")}`;
}

function getCallbackUrl(req) {
  return `${getBaseUrl(req)}/auth/zotero/callback`;
}

function cookieMap(req) {
  const raw = String(req.headers.cookie || "");
  const out = {};

  raw.split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index <= 0) return;

    const key = decodeURIComponent(part.slice(0, index).trim());
    const value = decodeURIComponent(part.slice(index + 1).trim());
    out[key] = value;
  });

  return out;
}

function encryptionKey() {
  if (!SESSION_SECRET) {
    throw new Error("Missing SESSION_SECRET.");
  }

  return crypto.createHash("sha256").update(SESSION_SECRET).digest();
}

function encryptCookiePayload(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);

  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

function decryptCookiePayload(value) {
  try {
    const [ivText, tagText, ciphertextText] = String(value || "").split(".");
    if (!ivText || !tagText || !ciphertextText) return null;

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivText, "base64url")
    );

    decipher.setAuthTag(Buffer.from(tagText, "base64url"));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final()
    ]);

    return JSON.parse(plaintext.toString("utf8"));
  } catch (_) {
    return null;
  }
}

function isHttps(req) {
  return Boolean(req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
}

function setEncryptedCookie(res, req, name, payload, maxAgeSeconds) {
  const value = encryptCookiePayload(payload);

  const pieces = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];

  if (isHttps(req)) pieces.push("Secure");

  res.append("Set-Cookie", pieces.join("; "));
}

function clearCookie(res, req, name) {
  const pieces = [
    `${encodeURIComponent(name)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (isHttps(req)) pieces.push("Secure");

  res.append("Set-Cookie", pieces.join("; "));
}

function readEncryptedCookie(req, name) {
  const value = cookieMap(req)[name];
  if (!value) return null;

  const payload = decryptCookiePayload(value);
  if (!payload) return null;

  if (payload.expiresAt && Date.now() > payload.expiresAt) return null;

  return payload;
}

function zoteroOAuthClient() {
  requireOAuthConfig();

  return OAuth({
    consumer: {
      key: ZOTERO_CLIENT_KEY,
      secret: ZOTERO_CLIENT_SECRET
    },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return crypto
        .createHmac("sha1", key)
        .update(baseString)
        .digest("base64");
    }
  });
}

function parseFormEncoded(text) {
  const params = new URLSearchParams(String(text || ""));
  return Object.fromEntries(params.entries());
}

async function oauthPost(url, data = {}, token = null) {
  const oauth = zoteroOAuthClient();

  const requestData = {
    url,
    method: "POST",
    data
  };

  const authorization = oauth.authorize(requestData, token || undefined);
  const headers = oauth.toHeader(authorization);

  const body = new URLSearchParams(data).toString();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded",
      accept: "application/x-www-form-urlencoded,text/plain,*/*"
    },
    body
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Zotero OAuth request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  return parseFormEncoded(text);
}

function getConnectedZotero(req) {
  const auth = readEncryptedCookie(req, ZOTERO_AUTH_COOKIE);

  if (!auth?.userId || !auth?.apiKey) return null;

  return {
    userId: String(auth.userId),
    username: String(auth.username || ""),
    apiKey: String(auth.apiKey)
  };
}

function requireConnectedZotero(req, res) {
  const auth = getConnectedZotero(req);

  if (!auth) {
    res.status(401).json({
      error: {
        code: "ZOTERO_NOT_CONNECTED",
        message: "Connect your Zotero account first."
      }
    });
    return null;
  }

  return auth;
}


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
/* Zotero OAuth + Web API                                                     */
/* -------------------------------------------------------------------------- */

function zoteroHeaders(apiKey) {
  return {
    accept: "application/json",
    "Zotero-API-Version": "3",
    "Zotero-API-Key": apiKey
  };
}

async function zoteroFetchJson(pathname, apiKey) {
  if (!apiKey) {
    throw new Error("Missing user-specific Zotero API key.");
  }

  const response = await fetch(`${ZOTERO_API_BASE}${pathname}`, {
    headers: zoteroHeaders(apiKey)
  });

  const text = await response.text();

  if (response.status === 403) {
    throw new Error("Zotero access was denied. The user may need to reconnect Zotero.");
  }

  if (!response.ok) {
    throw new Error(`Zotero request failed (${response.status}): ${text.slice(0, 300)}`);
  }

  return text ? JSON.parse(text) : null;
}

function zoteroCreators(creators = []) {
  return arr(creators)
    .map((creator) => {
      if (!creator) return "";
      if (creator.name) return cleanText(creator.name, 200);
      return cleanText(
        [creator.firstName, creator.lastName].filter(Boolean).join(" "),
        200
      );
    })
    .filter(Boolean)
    .join(", ");
}

function stripSimpleHtml(value = "") {
  return cleanText(
    String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
    12000
  );
}

function normalizeZoteroItem(item) {
  const data = item?.data || {};

  return {
    key: item?.key || data.key || "",
    version: item?.version || data.version || 0,
    itemType: data.itemType || "",
    title: cleanText(data.title || "(Untitled)", 1200),
    creators: zoteroCreators(data.creators || []),
    date: cleanText(data.date || "", 100),
    publicationTitle: cleanText(
      data.publicationTitle || data.bookTitle || data.proceedingsTitle || "",
      500
    ),
    volume: cleanText(data.volume || "", 50),
    issue: cleanText(data.issue || "", 50),
    pages: cleanText(data.pages || "", 100),
    DOI: cleanText(data.DOI || "", 300),
    url: cleanText(data.url || "", 1200),
    abstractNote: stripSimpleHtml(data.abstractNote || ""),
    tags: arr(data.tags)
      .map((tag) => cleanText(tag?.tag || tag, 150))
      .filter(Boolean)
      .slice(0, 30),
    dateModified: data.dateModified || "",
    parentItem: data.parentItem || ""
  };
}

function buildZoteroArticleContext({ item, notes = [], attachment = null, fullText = "" }) {
  const article = normalizeZoteroItem(item);
  const lines = [
    "## USER-SELECTED ZOTERO ARTICLE",
    `Zotero item key: ${article.key}`,
    `Item type: ${article.itemType || "Not reported"}`,
    `Title: ${article.title || "Not reported"}`,
    `Authors/creators: ${article.creators || "Not reported"}`,
    `Date: ${article.date || "Not reported"}`,
    `Journal/publication: ${article.publicationTitle || "Not reported"}`,
    `DOI: ${article.DOI || "Not reported"}`,
    `URL: ${article.url || "Not reported"}`
  ];

  if (article.abstractNote) {
    lines.push(`Abstract: ${article.abstractNote}`);
  } else {
    lines.push("Abstract: Not available in the Zotero item.");
  }

  if (article.tags.length) {
    lines.push(`Tags: ${article.tags.join(", ")}`);
  }

  const noteTexts = notes
    .map((note, index) => {
      const text = stripSimpleHtml(note?.data?.note || "");
      return text ? `Note ${index + 1}: ${text}` : "";
    })
    .filter(Boolean);

  if (noteTexts.length) {
    lines.push(`Zotero notes:\n${noteTexts.join("\n")}`);
  }

  if (attachment) {
    const attachmentData = attachment?.data || {};
    lines.push(
      `Attachment: ${cleanText(attachmentData.title || attachmentData.filename || "Attached file", 500)}`
    );
  }

  if (fullText) {
    lines.push(`Indexed full text from Zotero:\n${cleanText(fullText, 30000)}`);
  } else {
    lines.push(
      "Indexed full text: Not retrieved. Answer only from the metadata, abstract, and notes above."
    );
  }

  return lines.join("\n");
}

/* ------------------------------- OAuth flow ------------------------------- */

// Step 1: Begin Zotero OAuth.
// User is redirected to Zotero, where Zotero itself handles login and consent.
app.get("/auth/zotero/start", async (req, res) => {
  try {
    requireOAuthConfig();

    const callbackUrl = getCallbackUrl(req);

    const requestToken = await oauthPost(
      ZOTERO_OAUTH_REQUEST_URL,
      { oauth_callback: callbackUrl }
    );

    if (!requestToken.oauth_token || !requestToken.oauth_token_secret) {
      throw new Error("Zotero did not return a temporary OAuth token.");
    }

    setEncryptedCookie(
      res,
      req,
      ZOTERO_OAUTH_STATE_COOKIE,
      {
        oauthToken: requestToken.oauth_token,
        oauthTokenSecret: requestToken.oauth_token_secret,
        createdAt: Date.now(),
        expiresAt: Date.now() + OAUTH_STATE_MAX_AGE_SECONDS * 1000
      },
      OAUTH_STATE_MAX_AGE_SECONDS
    );

    const authorizeUrl = new URL(ZOTERO_OAUTH_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("oauth_token", requestToken.oauth_token);

    // Read-only permissions for the user's personal library and notes.
    authorizeUrl.searchParams.set("name", "Clinical Trial Evidence Assistant");
    authorizeUrl.searchParams.set("library_access", "1");
    authorizeUrl.searchParams.set("notes_access", "1");
    authorizeUrl.searchParams.set("write_access", "0");
    authorizeUrl.searchParams.set("all_groups", "none");

    res.redirect(authorizeUrl.toString());
  } catch (error) {
    console.error("Zotero OAuth start error:", error);
    res.status(500).send(
      `Could not start Zotero connection. ${String(error.message || error)}`
    );
  }
});

// Step 2: Zotero redirects back here after the user approves access.
// We exchange the temporary token for that user's long-lived Zotero API key.
app.get("/auth/zotero/callback", async (req, res) => {
  try {
    requireOAuthConfig();

    const oauthToken = cleanText(req.query.oauth_token || "", 300);
    const oauthVerifier = cleanText(req.query.oauth_verifier || "", 500);
    const state = readEncryptedCookie(req, ZOTERO_OAUTH_STATE_COOKIE);

    if (!oauthToken || !oauthVerifier || !state) {
      throw new Error("The Zotero authorization session is missing or expired.");
    }

    if (oauthToken !== state.oauthToken) {
      throw new Error("OAuth token mismatch. Please restart the Zotero connection.");
    }

    const access = await oauthPost(
      ZOTERO_OAUTH_ACCESS_URL,
      { oauth_verifier: oauthVerifier },
      {
        key: state.oauthToken,
        secret: state.oauthTokenSecret
      }
    );

    const userId = String(access.userID || access.userId || "");
    const username = String(access.username || "");
    const apiKey = String(access.oauth_token_secret || access.oauth_token || "");

    if (!userId || !apiKey) {
      throw new Error("Zotero did not return the expected user ID and API key.");
    }

    setEncryptedCookie(
      res,
      req,
      ZOTERO_AUTH_COOKIE,
      {
        userId,
        username,
        apiKey,
        createdAt: Date.now(),
        expiresAt: Date.now() + AUTH_COOKIE_MAX_AGE_SECONDS * 1000
      },
      AUTH_COOKIE_MAX_AGE_SECONDS
    );

    clearCookie(res, req, ZOTERO_OAUTH_STATE_COOKIE);

    res.redirect("/?zotero=connected");
  } catch (error) {
    console.error("Zotero OAuth callback error:", error);
    clearCookie(res, req, ZOTERO_OAUTH_STATE_COOKIE);
    res.redirect(`/?zotero=error&message=${encodeURIComponent(String(error.message || error))}`);
  }
});

// The frontend uses this route to decide whether to show Connect or Disconnect.
app.get("/api/zotero/status", (req, res) => {
  const auth = getConnectedZotero(req);

  res.json({
    connected: Boolean(auth),
    userId: auth?.userId || "",
    username: auth?.username || ""
  });
});

// Disconnect only forgets the Zotero credential in this browser.
// The user can revoke the generated key from Zotero account settings if desired.
app.post("/auth/zotero/disconnect", (req, res) => {
  clearCookie(res, req, ZOTERO_AUTH_COOKIE);
  clearCookie(res, req, ZOTERO_OAUTH_STATE_COOKIE);
  res.json({ ok: true });
});

/* ----------------------------- Zotero library ----------------------------- */

app.get("/api/zotero/library", async (req, res) => {
  const auth = requireConnectedZotero(req, res);
  if (!auth) return;

  try {
    const q = cleanText(req.query.q || "", 300).toLowerCase();

    const params = new URLSearchParams({
      limit: "100",
      sort: "dateModified",
      direction: "desc",
      format: "json"
    });

    const rawItems = await zoteroFetchJson(
      `/users/${encodeURIComponent(auth.userId)}/items/top?${params.toString()}`,
      auth.apiKey
    );

    const excludedTypes = new Set(["attachment", "note", "annotation"]);

    let items = arr(rawItems)
      .map(normalizeZoteroItem)
      .filter((item) => item.key && !excludedTypes.has(item.itemType));

    if (q) {
      items = items.filter((item) => {
        const haystack = [
          item.title,
          item.creators,
          item.publicationTitle,
          item.DOI,
          item.tags.join(" ")
        ]
          .join(" ")
          .toLowerCase();

        return haystack.includes(q);
      });
    }

    res.json({
      userId: auth.userId,
      username: auth.username,
      count: items.length,
      items
    });
  } catch (error) {
    res.status(500).json({
      error: { message: `Could not load Zotero library: ${error.message}` }
    });
  }
});

app.get("/api/zotero/article/:itemKey", async (req, res) => {
  const auth = requireConnectedZotero(req, res);
  if (!auth) return;

  try {
    const itemKey = cleanText(req.params.itemKey || "", 40);

    if (!/^[A-Za-z0-9]+$/.test(itemKey)) {
      return res.status(400).json({
        error: { message: "Invalid Zotero item key." }
      });
    }

    const item = await zoteroFetchJson(
      `/users/${encodeURIComponent(auth.userId)}/items/${encodeURIComponent(itemKey)}`,
      auth.apiKey
    );

    let children = [];
    try {
      children = await zoteroFetchJson(
        `/users/${encodeURIComponent(auth.userId)}/items/${encodeURIComponent(itemKey)}/children?limit=100&format=json`,
        auth.apiKey
      );
    } catch (_) {
      children = [];
    }

    const notes = arr(children).filter(
      (child) => child?.data?.itemType === "note"
    );

    const attachments = arr(children).filter(
      (child) => child?.data?.itemType === "attachment"
    );

    const pdfAttachment =
      attachments.find((attachment) =>
        /pdf/i.test(
          `${attachment?.data?.contentType || ""} ${attachment?.data?.filename || ""} ${attachment?.data?.title || ""}`
        )
      ) || attachments[0] || null;

    let fullText = "";
    let fullTextMeta = null;

    if (pdfAttachment?.key) {
      try {
        fullTextMeta = await zoteroFetchJson(
          `/users/${encodeURIComponent(auth.userId)}/items/${encodeURIComponent(pdfAttachment.key)}/fulltext`,
          auth.apiKey
        );

        fullText = cleanText(fullTextMeta?.content || "", 30000);
      } catch (_) {
        fullText = "";
        fullTextMeta = null;
      }
    }

    const normalized = normalizeZoteroItem(item);
    const context = buildZoteroArticleContext({
      item,
      notes,
      attachment: pdfAttachment,
      fullText
    });

    res.json({
      article: normalized,
      attachment: pdfAttachment
        ? {
            key: pdfAttachment.key,
            title: cleanText(
              pdfAttachment?.data?.title || pdfAttachment?.data?.filename || "Attachment",
              500
            ),
            filename: cleanText(pdfAttachment?.data?.filename || "", 500),
            contentType: cleanText(pdfAttachment?.data?.contentType || "", 200)
          }
        : null,
      fullTextAvailable: Boolean(fullText),
      indexedPages: fullTextMeta?.indexedPages || null,
      totalPages: fullTextMeta?.totalPages || null,
      context
    });
  } catch (error) {
    res.status(500).json({
      error: { message: `Could not load Zotero article: ${error.message}` }
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
  res.json({ ok: true, model: ANTHROPIC_MODEL, zoteroOAuthConfigured: Boolean(ZOTERO_CLIENT_KEY && ZOTERO_CLIENT_SECRET && SESSION_SECRET) });
});

app.listen(PORT, () => {
  console.log(`Clinical Trial Evidence Assistant running at http://localhost:${PORT}`);
});
