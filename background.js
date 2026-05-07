/**
 * background.js — Service Worker
 * Calls the SummAI proxy server. No API key is stored or needed in the extension.
 * Users can use the extension right out of the box.
 */

// !! IMPORTANT: After deploying to Vercel, replace this URL with your real deployment URL
const PROXY_URL = "https://summaiproxy.vercel.app/api/summarize";

const CACHE_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// ─── Message Router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isValidSender(sender)) {
    sendResponse({ error: "Unauthorized message sender." });
    return false;
  }

  switch (message.type) {
    case "SUMMARIZE_PAGE":
      handleSummarize(message.payload, sendResponse);
      return true;
    case "CLEAR_CACHE":
      clearCache(message.payload?.url, sendResponse);
      return true;
    case "GET_SETTINGS":
      getSettings(sendResponse);
      return true;
    case "SAVE_SETTINGS":
      saveSettings(message.payload, sendResponse);
      return true;
    default:
      sendResponse({ error: "Unknown message type." });
      return false;
  }
});

// ─── Sender Validation ─────────────────────────────────────────────────────────
function isValidSender(sender) {
  if (sender.url && sender.url.startsWith(chrome.runtime.getURL(""))) return true;
  if (sender.tab) return true;
  return false;
}

// ─── Main Summarize Handler ────────────────────────────────────────────────────
async function handleSummarize({ url, content, title }, sendResponse) {
  try {
    if (!url || !content) {
      sendResponse({ error: "Missing page URL or content." });
      return;
    }

    // 1. Check cache first
    const cached = await getCachedSummary(url);
    if (cached) {
      sendResponse({ success: true, summary: cached, fromCache: true });
      return;
    }

    // 2. Call proxy server
    const summary = await callProxy(title, content);

    // 3. Cache the result
    await cacheSummary(url, summary);

    sendResponse({ success: true, summary, fromCache: false });
  } catch (err) {
    console.error("[AI Summarizer] Error:", err);
    sendResponse({ error: err.message || "An unexpected error occurred." });
  }
}

// ─── Proxy Call ────────────────────────────────────────────────────────────────
async function callProxy(title, rawContent) {
  const cleaned = cleanContent(rawContent);

  let response;
  try {
    response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content: cleaned }),
    });
  } catch (err) {
    throw new Error("Could not reach the SummAI server. Check your internet connection.");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 429) {
      throw new Error("The AI is busy right now. Please wait a moment and try again.");
    }
    throw new Error(body.error || `Server error (${response.status}). Please try again.`);
  }

  const data = await response.json();

  if (!data.success || !data.summary) {
    throw new Error(data.error || "Invalid response from server.");
  }

  // Sanitize all fields
  const s = data.summary;
  return {
    summary:     (s.summary     || []).map(sanitize),
    keyInsights: (s.keyInsights || []).map(sanitize),
    readingTime: sanitize(s.readingTime || "3 min read"),
    wordCount:   parseInt(s.wordCount)  || 0,
    sentiment:   sanitize(s.sentiment   || "neutral"),
    topics:      (s.topics      || []).map(sanitize),
  };
}

// ─── Content Cleaner ───────────────────────────────────────────────────────────
function cleanContent(raw) {
  const lines = raw.split("\n");
  const seen  = new Set();
  const kept  = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t || t.length < 25 || seen.has(t)) continue;
    if (/^[{}\[\]();<>]/.test(t)) continue;
    if (/^\s*(import|export|const|let|var|function|class|\/\/)/.test(t)) continue;
    if (/^[a-z0-9_\-\.\/]+\.(js|ts|jsx|tsx|css|json|py)$/i.test(t)) continue;
    seen.add(t);
    kept.push(t);
    if (kept.join(" ").length > 2000) break;
  }

  return kept.join(" ").slice(0, 2000);
}

// ─── Sanitize ──────────────────────────────────────────────────────────────────
function sanitize(str) {
  if (typeof str !== "string") return String(str);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ─── Cache ─────────────────────────────────────────────────────────────────────
async function getCachedSummary(url) {
  const key    = `cache_${btoa(unescape(encodeURIComponent(url))).slice(0, 50)}`;
  const result = await chrome.storage.local.get(key);
  const entry  = result[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_EXPIRY_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.summary;
}

async function cacheSummary(url, summary) {
  const key = `cache_${btoa(unescape(encodeURIComponent(url))).slice(0, 50)}`;
  await chrome.storage.local.set({ [key]: { summary, timestamp: Date.now(), url } });
}

async function clearCache(url, sendResponse) {
  try {
    if (url) {
      const key = `cache_${btoa(unescape(encodeURIComponent(url))).slice(0, 50)}`;
      await chrome.storage.local.remove(key);
    } else {
      const all  = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(k => k.startsWith("cache_"));
      if (keys.length) await chrome.storage.local.remove(keys);
    }
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ─── Settings ──────────────────────────────────────────────────────────────────
// No API key stored — extension works out of the box
async function getSettings(sendResponse) {
  try {
    const data = await chrome.storage.local.get(["theme"]);
    sendResponse({
      success: true,
      settings: {
        hasApiKey:   true, // always true — key is on server
        apiProvider: "gemini",
        theme:       data.theme || "dark",
      },
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function saveSettings(payload, sendResponse) {
  try {
    const toSave = {};
    if (payload.theme !== undefined) toSave.theme = payload.theme;
    await chrome.storage.local.set(toSave);
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}
