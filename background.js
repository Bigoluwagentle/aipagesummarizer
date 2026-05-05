/**
 * background.js — Service Worker
 * Handles all AI API communication securely.
 * API keys are NEVER exposed to content scripts or popup JS.
 */

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

    // 2. Get API key from storage
    const { apiKey, apiProvider } = await getStorageValues(["apiKey", "apiProvider"]);
    if (!apiKey) {
      sendResponse({
        error: "No API key found. Please go to Settings and add your Gemini API key.",
        needsSetup: true,
      });
      return;
    }

    // 3. Call AI API (with retry on rate limit)
    const provider = apiProvider || "gemini";
    const summary = await callAIWithRetry(provider, apiKey, content, title);

    // 4. Cache the result
    await cacheSummary(url, summary);

    sendResponse({ success: true, summary, fromCache: false });
  } catch (err) {
    console.error("[AI Summarizer] Error:", err);
    sendResponse({ error: err.message || "An unexpected error occurred." });
  }
}

// ─── Smart Content Cleaner ────────────────────────────────────────────────────
function cleanContentForAI(rawContent) {
  // Split into lines and filter aggressively
  const lines = rawContent.split("\n");
  const seen = new Set();
  const kept = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty, very short, or duplicate lines
    if (!trimmed || trimmed.length < 25) continue;
    if (seen.has(trimmed)) continue;

    // Skip lines that look like code, file paths, or GitHub noise
    if (/^[{}\[\]();<>\/\\]/.test(trimmed)) continue;        // code symbols
    if (/^\s*(import|export|const|let|var|function|class|\/\/)/.test(trimmed)) continue; // code keywords
    if (/^[a-z0-9_\-\.\/]+\.(js|ts|jsx|tsx|css|md|json|py|go|rb)$/i.test(trimmed)) continue; // filenames
    if (/^\d+$/.test(trimmed)) continue;                      // just numbers
    if ((trimmed.match(/\|/g) || []).length > 3) continue;    // table rows with lots of pipes

    seen.add(trimmed);
    kept.push(trimmed);

    // Stop once we have enough meaningful content
    if (kept.join(" ").length > 1800) break;
  }

  return kept.join(" ").slice(0, 1800);
}

// ─── AI Caller with Retry ──────────────────────────────────────────────────────
async function callAIWithRetry(provider, apiKey, rawContent, title) {
  const cleaned = cleanContentForAI(rawContent);
  const prompt = buildPrompt(title, cleaned);

  // One retry after 10 seconds for transient errors
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      if (provider === "gemini") return await callGemini(apiKey, prompt);
      if (provider === "openai") return await callOpenAI(apiKey, prompt);
      throw new Error("Unknown provider.");
    } catch (err) {
      if (err.message === "QUOTA_EXCEEDED") {
        if (attempt === 0) {
          await sleep(10000); // wait 10s and try once more
          continue;
        }
        // Still failing after retry — quota genuinely exhausted
        throw new Error(
          "Gemini API quota reached (250 requests/day on free tier). " +
          "Quota resets at midnight Pacific Time. " +
          "Note: creating a new key in the same project does NOT reset quota — " +
          "quota is per project. To continue now, create a NEW PROJECT at " +
          "console.cloud.google.com, generate an API key there, and paste it in Settings."
        );
      }
      throw err; // non-quota errors throw immediately, no retry
    }
  }
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Prompt Builder ────────────────────────────────────────────────────────────
function buildPrompt(title, content) {
  return `Summarize this webpage content. Return ONLY a raw JSON object. No markdown, no code fences, no extra text.

Title: ${title}
Content: ${content}

Required JSON:
{"summary":["point 1","point 2","point 3","point 4"],"keyInsights":["insight 1","insight 2"],"readingTime":"2 min read","wordCount":400,"sentiment":"neutral","topics":["topic1","topic2"]}

Rules: 4-5 summary bullets, 2-3 insights, sentiment = neutral/positive/negative/mixed. Raw JSON only.`;
}

// ── Gemini API ─────────────────────────────────────────────────────────────────
async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
        },
      }),
    });
  } catch (fetchErr) {
    throw new Error("Network error. Check your internet connection.");
  }

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const status = response.status;
    const apiMsg = errBody?.error?.message || "";
    console.log(`[AI Summarizer] Gemini ${status}:`, apiMsg);

    if (status === 401 || status === 403) throw new Error("API key rejected. Check your Gemini API key in Settings.");
    if (status === 404) throw new Error("Gemini model not found. Make sure your API key is active at aistudio.google.com.");
    if (status === 429 || status === 503) throw new Error("QUOTA_EXCEEDED");
    throw new Error(apiMsg || `Gemini error (${status}). Please try again.`);
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.find(p => p.text)?.text || null;

  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason;
    if (reason === "SAFETY") throw new Error("Content blocked by safety filter. Try a different page.");
    throw new Error("Empty response from Gemini. Please try again.");
  }

  return parseAIResponse(text);
}

// ── OpenAI API ─────────────────────────────────────────────────────────────────
async function callOpenAI(apiKey, prompt) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 800,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const status = response.status;
    if (status === 401) throw new Error("Invalid OpenAI API key. Check your key in Settings.");
    if (status === 429) throw new Error(`429`);
    if (status === 402) throw new Error("OpenAI account has no credits. Please top up your account.");
    throw new Error(err?.error?.message || `OpenAI error (${status}).`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned an empty response. Please try again.");

  return parseAIResponse(text);
}

// ─── Response Parser ───────────────────────────────────────────────────────────
function parseAIResponse(text) {
  try {
    // Gemini 2.5 includes thinking tokens before the actual response.
    // We extract the JSON object by finding the first { and last } in the text.
    let jsonStr = null;

    // Strategy 1: strip markdown fences then parse
    const stripped = text.replace(/```json\n?|```\n?/g, "").trim();
    if (stripped.startsWith("{")) {
      jsonStr = stripped;
    }

    // Strategy 2: find the first { ... } block in the full text (handles thinking prefix)
    if (!jsonStr) {
      const firstBrace = text.indexOf("{");
      const lastBrace  = text.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = text.slice(firstBrace, lastBrace + 1);
      }
    }

    if (!jsonStr) throw new Error("No JSON found in response.");

    const parsed = JSON.parse(jsonStr);

    // Flexible validation — Gemini sometimes uses different key names
    const summary = parsed.summary || parsed.Summary || parsed.bullets || [];
    const keyInsights = parsed.keyInsights || parsed.key_insights || parsed.insights || parsed.KeyInsights || [];
    const readingTime = parsed.readingTime || parsed.reading_time || parsed.readTime || "~3 min read";
    const wordCount   = parsed.wordCount   || parsed.word_count   || parsed.words    || 0;
    const sentiment   = parsed.sentiment   || parsed.tone         || "neutral";
    const topics      = parsed.topics      || parsed.Tags         || parsed.tags     || [];

    if (!Array.isArray(summary) || summary.length === 0) {
      throw new Error("AI response missing summary field.");
    }

    return {
      summary:     summary.map(sanitize),
      keyInsights: Array.isArray(keyInsights) ? keyInsights.map(sanitize) : [],
      readingTime: sanitize(String(readingTime)),
      wordCount:   parseInt(wordCount) || 0,
      sentiment:   sanitize(String(sentiment)),
      topics:      Array.isArray(topics) ? topics.map(sanitize) : [],
    };
  } catch (e) {
    console.error("[AI Summarizer] Parse error:", e.message, "\nRaw text:", text?.slice(0, 300));
    throw new Error("Could not parse the AI response: " + e.message);
  }
}

function sanitize(str) {
  if (typeof str !== "string") return String(str);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ─── Cache Helpers ─────────────────────────────────────────────────────────────
async function getCachedSummary(url) {
  const cacheKey = `cache_${btoa(unescape(encodeURIComponent(url))).slice(0, 50)}`;
  const result = await chrome.storage.local.get(cacheKey);
  const entry = result[cacheKey];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_EXPIRY_MS) {
    await chrome.storage.local.remove(cacheKey);
    return null;
  }
  return entry.summary;
}

async function cacheSummary(url, summary) {
  const cacheKey = `cache_${btoa(unescape(encodeURIComponent(url))).slice(0, 50)}`;
  await chrome.storage.local.set({
    [cacheKey]: { summary, timestamp: Date.now(), url },
  });
}

async function clearCache(url, sendResponse) {
  try {
    if (url) {
      const cacheKey = `cache_${btoa(unescape(encodeURIComponent(url))).slice(0, 50)}`;
      await chrome.storage.local.remove(cacheKey);
    } else {
      const all = await chrome.storage.local.get(null);
      const cacheKeys = Object.keys(all).filter(k => k.startsWith("cache_"));
      if (cacheKeys.length) await chrome.storage.local.remove(cacheKeys);
    }
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ─── Settings Helpers ──────────────────────────────────────────────────────────
async function getSettings(sendResponse) {
  try {
    const data = await getStorageValues(["apiKey", "apiProvider", "theme"]);
    sendResponse({
      success: true,
      settings: {
        hasApiKey:   !!data.apiKey,
        apiProvider: data.apiProvider || "gemini",
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
    if (payload.apiKey      !== undefined) toSave.apiKey      = payload.apiKey.trim();
    if (payload.apiProvider !== undefined) toSave.apiProvider = payload.apiProvider;
    if (payload.theme       !== undefined) toSave.theme       = payload.theme;
    await chrome.storage.local.set(toSave);
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ─── Storage Utility ───────────────────────────────────────────────────────────
function getStorageValues(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}
