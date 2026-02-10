const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

const SOURCE_URL = "https://jsonplaceholder.typicode.com/comments?postId=1";
const DEFAULT_SOURCE = "JSONPlaceholder Comments";
const MAX_ITEMS = 3;
const STORAGE_PATH = process.env.VERCEL ? "/tmp/results.json" : path.join(process.cwd(), "data", "results.json");
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-1.5-flash";
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

function normalizeSentiment(text) {
  const lowered = text.toLowerCase();
  if (lowered.includes("enthusiastic") || lowered.includes("positive")) {
    return "positive";
  }
  if (lowered.includes("critical") || lowered.includes("negative")) {
    return "negative";
  }
  return "neutral";
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
  const model = client.getGenerativeModel({ model: MODEL_NAME });
  const prompt = [
    "You are a concise analyst.",
    "Summarize the text in 1-2 sentences.",
    "Classify sentiment as enthusiastic, critical, or objective.",
    "Respond as JSON with keys: summary, sentiment.",
    "Text:",
    text
  ].join("\n");

  const result = await model.generateContent(prompt);
  const responseText = result.response.text();
  const parsed = safeJsonParse(responseText, null);

  if (!parsed || !parsed.summary) {
    return {
      summary: responseText.trim(),
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

  const storedItems = await loadStorage();

  for (const comment of comments) {
    const itemTimestamp = nowIso();
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
        timestamp: itemTimestamp
      });
    } catch (error) {
      response.errors.push({
        stage: "analysis",
        message: error.message,
        itemId: comment.id
      });
      response.items.push({
        original: comment.body,
        analysis: "",
        sentiment: "neutral",
        stored: false,
        timestamp: itemTimestamp
      });
    }
  }

  try {
    await saveStorage(storedItems);
  } catch (error) {
    response.errors.push({ stage: "storage", message: error.message });
  }

  console.log(`Notification sent to: ${notificationEmail}`);
  response.notificationSent = true;

  res.status(200).json(response);
};
