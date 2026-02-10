const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

const SOURCE_URL = "https://jsonplaceholder.typicode.com/comments?postId=1";
const DEFAULT_SOURCE = "JSONPlaceholder Comments";
const MAX_ITEMS = 3;
const STORAGE_PATH = process.env.VERCEL ? "/tmp/results.json" : path.join(process.cwd(), "data", "results.json");
const MODEL_NAME = process.env.GEMINI_MODEL || "google:gemma-3-27b-it";
const REQUEST_TIMEOUT_MS = 8000;

function nowIso() {
  return new Date().toISOString();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function isQuotaError(error) {
  const message = String(error?.message || error || "");
  return /\b429\b|quota exceeded|rate limit/i.test(message);
}

function stripCodeFences(text) {
  if (typeof text !== "string") {
    return "";
  }
  return text.replace(/```json\s*|```/gi, "").trim();
}

function normalizeSentiment(text) {
  const lowered = String(text || "").toLowerCase();
  if (lowered.includes("enthusiastic") || lowered.includes("positive")) {
    return "enthusiastic";
  }
  if (lowered.includes("critical") || lowered.includes("negative")) {
    return "critical";
  }
  return "objective";
}

async function loadStorage() {
  try {
    const content = await fs.promises.readFile(STORAGE_PATH, "utf8");
    return safeJsonParse(content, []);
  } catch (error) {
    return [];
  }
}

async function saveStorage(items) {
  const dir = path.dirname(STORAGE_PATH);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(STORAGE_PATH, JSON.stringify(items, null, 2));
}

async function analyzeWithGemini(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const client = new GoogleGenerativeAI(apiKey);
  const prompt = [
    "You are a concise analyst.",
    "Summarize the text in 1-2 sentences.",
    "Classify sentiment as enthusiastic, critical, or objective.",
    "Respond as JSON with keys: summary, sentiment.",
    "Text:",
    text
  ].join("\n");

  const modelNames = Array.from(new Set([
    MODEL_NAME,
    "gemma-3-27b-it",
    "gemma-3-12b-it",
    "gemma-3-1b-it",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash",
    "gemini-2-flash-latest",
    "gemini-2-flash",
    "gemini-3-pro-preview",
    "gemini-2.5-pro",
    "gemini-3-flash-latest",
    "gemini-3-flash",
    "gemini-2.5-flash"
  ]))
    .filter(Boolean);
  let responseText = "";
  let lastError = null;

  for (const modelName of modelNames) {
    try {
      const model = client.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      responseText = result.response.text();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!/not found|not supported/i.test(String(error.message || error))) {
        break;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  const parsed = safeJsonParse(stripCodeFences(responseText), null);

  if (!parsed || !parsed.summary) {
    return {
      summary: responseText.trim() || "Analysis unavailable.",
      sentiment: normalizeSentiment(responseText)
    };
  }

  return {
    summary: parsed.summary,
    sentiment: normalizeSentiment(parsed.sentiment || "")
  };
}

async function fetchComments() {
  const response = await fetchWithTimeout(SOURCE_URL);
  if (!response.ok) {
    const error = new Error(`Upstream API failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  return Array.isArray(data) ? data.slice(0, MAX_ITEMS) : [];
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { email, source } = req.body || {};
  const notificationEmail = email || "notification-email@example.com";
  const sourceName = source || DEFAULT_SOURCE;
  const processedAt = nowIso();

  const response = {
    items: [],
    notificationSent: false,
    processedAt,
    errors: []
  };

  let comments = [];
  try {
    comments = await fetchComments();
  } catch (error) {
    response.errors.push({ stage: "fetch", message: error.message, status: error.status || 500 });
  }

  const loadedItems = await loadStorage();
  const storedItems = (() => {
    const seen = new Set();
    const normalized = [];
    for (const item of loadedItems) {
      const id = item?.id;
      if (id == null || seen.has(id)) {
        continue;
      }
      seen.add(id);
      normalized.push({
        ...item,
        stored: Boolean(item?.stored)
      });
    }
    return normalized;
  })();
  const cachedById = new Map();
  for (const item of storedItems) {
    if (item && item.id != null) {
      cachedById.set(item.id, item);
    }
  }
  let quotaExceeded = false;

  for (const comment of comments) {
    const itemTimestamp = nowIso();
    const cached = cachedById.get(comment.id);
    if (cached) {
      response.items.push({
        original: cached.original || comment.body,
        analysis: cached.analysis || "Analysis unavailable.",
        sentiment: normalizeSentiment(cached.sentiment),
        stored: true,
        timestamp: cached.timestamp || itemTimestamp,
        source: cached.source || sourceName
      });
      continue;
    }

    if (quotaExceeded) {
      response.items.push({
        original: comment.body,
        analysis: "Analysis unavailable.",
        sentiment: "objective",
        stored: false,
        timestamp: itemTimestamp
      });
      continue;
    }

    try {
      const analysis = await analyzeWithGemini(comment.body);
      const enriched = {
        original: comment.body,
        analysis: analysis.summary,
        sentiment: analysis.sentiment,
        stored: true,
        timestamp: itemTimestamp,
        source: sourceName
      };
      response.items.push(enriched);
      storedItems.push({
        id: comment.id,
        email: notificationEmail,
        source: sourceName,
        original: comment.body,
        analysis: analysis.summary,
        sentiment: analysis.sentiment,
        stored: true,
        timestamp: itemTimestamp
      });
    } catch (error) {
      if (isQuotaError(error)) {
        if (!quotaExceeded) {
          response.errors.push({
            stage: "analysis",
            message: "Rate limit or quota exceeded",
            itemId: comment.id
          });
        }
        quotaExceeded = true;
      } else {
        response.errors.push({
          stage: "analysis",
          message: error.message,
          itemId: comment.id
        });
      }
      response.items.push({
        original: comment.body,
        analysis: "Analysis unavailable.",
        sentiment: "objective",
        stored: false,
        timestamp: itemTimestamp
      });
    }
  }

  response.items = response.items.map((item) => ({
    ...item,
    stored: Boolean(item.stored)
  }));

  response.items.forEach(item => {
    if (typeof item.stored === 'undefined') {
      item.stored = false;
    }
  });

  const normalizedStoredItems = storedItems.map((item) => ({
    ...item,
    stored: Boolean(item?.stored)
  }));

  try {
    await saveStorage(normalizedStoredItems);
  } catch (error) {
    response.errors.push({ stage: "storage", message: error.message });
  }

  console.log(`Notification sent to: ${notificationEmail}`);
  response.notificationSent = true;

  res.status(200).json(response);
};
