const CACHE_EXPIRY_MS = 30 * 60 * 1000; 

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

function isValidSender(sender) {
  if (sender.url && sender.url.startsWith(chrome.runtime.getURL(""))) return true;
  if (sender.tab) return true;
  return false;
}

async function handleSummarize({ url, content, title }, sendResponse) {
  try {
    if (!url || !content) {
      sendResponse({ error: "Missing page URL or content." });
      return;
    }

    const cached = await getCachedSummary(url);
    if (cached) {
      sendResponse({ success: true, summary: cached, fromCache: true });
      return;
    }

    const { apiKey, apiProvider } = await getStorageValues(["apiKey", "apiProvider"]);
    if (!apiKey) {
      sendResponse({
        error: "No API key found. Please go to Settings and add your Gemini API key.",
        needsSetup: true,
      });
      return;
    }

    const provider = apiProvider || "gemini";
    const summary = await callAIWithRetry(provider, apiKey, content, title);

    await cacheSummary(url, summary);

    sendResponse({ success: true, summary, fromCache: false });
  } catch (err) {
    console.error("[AI Summarizer] Error:", err);
    sendResponse({ error: err.message || "An unexpected error occurred." });
  }
}

async function callAIWithRetry(provider, apiKey, content, title) {
  const truncated = content.slice(0, 2500);
  const prompt = buildPrompt(title, truncated);

  const MAX_RETRIES = 3;
  const WAIT_TIMES = [5000, 15000, 30000]; 

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (provider === "gemini") {
        return await callGemini(apiKey, prompt);
      } else if (provider === "openai") {
        return await callOpenAI(apiKey, prompt);
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (err) {
      const is429 = err.message === "429" || (err.message && err.message.includes("429"));

      if (is429 && attempt < MAX_RETRIES) {
        const waitMs = WAIT_TIMES[attempt] || 30000;
        console.log(`[AI Summarizer] Rate limited. Waiting ${waitMs/1000}s before retry ${attempt + 1}/${MAX_RETRIES}...`);
        await sleep(waitMs);
        continue;
      }

      if (is429) {
        throw new Error(
          "Rate limit reached on the free Gemini API. " +
          "Please wait 60 seconds then try again. " +
          "The free tier allows 15 requests per minute."
        );
      }

      throw err;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPrompt(title, content) {
  return `Summarize the following webpage. Return ONLY a raw JSON object — no markdown, no code fences, no explanation, no thinking text. Just the JSON.

Title: ${title}

Content:
${content}

JSON format:
{"summary":["point 1","point 2","point 3","point 4"],"keyInsights":["insight 1","insight 2","insight 3"],"readingTime":"3 min read","wordCount":500,"sentiment":"neutral","topics":["topic1","topic2"]}

Rules: summary has 4-5 bullet points. keyInsights has 2-3 items. sentiment is one of: neutral, positive, negative, mixed. Output raw JSON only.`;
}

async function callGemini(apiKey, prompt) {
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
  } catch (fetchErr) {
    throw new Error("Network error: Could not reach Gemini API. Check your internet connection.");
  }

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const status = response.status;
    const apiMsg = errBody?.error?.message || "";

    if (status === 400) throw new Error("Invalid API key or bad request. Check your Gemini API key in Settings.");
    if (status === 401 || status === 403) throw new Error("API key rejected. Make sure your Gemini API key is correct and active.");
    if (status === 429) throw new Error("429");
    if (status === 503) throw new Error("429");
    if (status === 404) throw new Error("Gemini model not found. Your API key may not have access yet.");
    throw new Error(apiMsg || `Gemini API error (${status}). Please try again.`);
  }

  const data = await response.json();

  let text = null;
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.text && !part.thought) {
      text = part.text;
      break;
    }
  }

  if (!text) text = parts.find(p => p.text)?.text;

  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason;
    if (reason === "SAFETY") throw new Error("Content blocked by Gemini safety filter. Try a different page.");
    throw new Error("Gemini returned an empty response. Please try again.");
  }

  return parseAIResponse(text);
}

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

function parseAIResponse(text) {
  try {
    let jsonStr = null;

    const stripped = text.replace(/```json\n?|```\n?/g, "").trim();
    if (stripped.startsWith("{")) {
      jsonStr = stripped;
    }

    if (!jsonStr) {
      const firstBrace = text.indexOf("{");
      const lastBrace  = text.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = text.slice(firstBrace, lastBrace + 1);
      }
    }

    if (!jsonStr) throw new Error("No JSON found in response.");

    const parsed = JSON.parse(jsonStr);

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

function getStorageValues(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}
