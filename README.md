# SummAI — AI Page Summarizer Chrome Extension

> A Chrome Extension (Manifest V3) that extracts webpage content, sends it to an AI API, and displays a structured summary with bullet points, key insights, reading time, and more.

---

## Demo Video

🎥 **[Watch Demo](https://drive.google.com/file/d/1Tkr9JqbOzg6aIBtC-mzeUn60-g9-vX_n/view?usp=sharing)**

> The demo video (2:11 minutes) covers:
> - Loading the extension in Chrome via Developer Mode
> - Summarizing a live article page
> - Showing bullet summary, key insights, reading time, and word count
> - Demonstrating dark/light mode toggle
> - Showing the copy-to-clipboard and cache/refresh behaviour

---

## Features

- **Instant Summarization** — Click once to summarize any article or webpage
- **Bullet-point Summary** — 4–6 concise points covering the main content
- **Key Insights** — 2–4 most important takeaways
- **Reading Time & Word Count** — Estimated at a glance
- **Sentiment Detection** — Positive / Negative / Mixed / Neutral
- **Topic Tags** — Auto-detected topic categories
- **Smart Caching** — Results cached per URL for 30 minutes (no duplicate API calls)
- **Dark / Light Mode** — Toggle in the popup header
- **Copy to Clipboard** — Export the full summary as Markdown
- **Force Refresh** — Bypass cache and re-generate a fresh summary
- **Multi-provider** — Supports Google Gemini and OpenAI

---

## Setup Instructions

### Prerequisites

- Google Chrome (or Chromium-based browser)
- A free [Gemini API key](https://aistudio.google.com/app/apikey) **or** an [OpenAI API key](https://platform.openai.com/api-keys)

---

### Step 1 — Download the Extension

Clone or download this repository:

```bash
git clone https://github.com/bigoluwagentle/pagesummarizer.git
```

Or download the ZIP and unzip it.

---

### Step 2 — Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer Mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the `ai-page-summarizer` folder (the one containing `manifest.json`)
5. The **SummAI** extension will appear in your toolbar

> **Note:** This is a local/unpacked extension. It is not published to the Chrome Web Store.

---

### Step 3 — Add Your API Key

Your API key is stored **locally on your device** using `chrome.storage.local`. It is never sent anywhere except directly to the AI provider's official API endpoint.

---

### Step 4 — Summarize a Page

1. Navigate to any article, blog post, or news page
2. Click the **SummAI** icon in the toolbar
3. Click **"Summarize Page"**
4. The summary will appear within a few seconds

---

## Architecture

```
ai-page-summarizer/
├── manifest.json          # MV3 extension manifest
├── background.js          # Service worker: AI API calls, caching, storage
├── content.js             # Content script: page content extraction
├── popup.html             # Popup UI markup
├── popup.css              # Popup styles (dark/light theme)
├── popup.js               # Popup controller logic
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

### Component Responsibilities

| File | Role |
|---|---|
| `manifest.json` | Declares permissions, entry points, and metadata |
| `background.js` | **Service Worker** — handles AI API calls, caching, and settings storage. The only file that ever touches the API key. |
| `content.js` | **Content Script** — runs on every page, extracts readable content using heuristics |
| `popup.html/css/js` | **Extension Popup** — the UI the user interacts with |

### Message Passing Flow

```
Popup (popup.js)
  │
  ├─ chrome.tabs.sendMessage ──► Content Script (content.js)
  │                               └─ Extracts text, returns it
  │
  └─ chrome.runtime.sendMessage ──► Background Worker (background.js)
                                     ├─ Checks cache (chrome.storage)
                                     ├─ Calls AI API (Gemini / OpenAI)
                                     └─ Returns structured summary
```

---

## AI Integration

### Provider: Google Gemini (default)

- **Model:** `gemini-2.5-flash` (latest stable Gemini 2.5, free tier available)
- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`
- **Thinking mode:** Disabled (`thinkingBudget: 0`) to save quota and avoid output token issues

### Provider: OpenAI

- **Model:** `gpt-4o-mini` (low cost, capable)
- **Endpoint:** `https://api.openai.com/v1/chat/completions`
- **Response format:** `response_format: { type: "json_object" }`

### Prompt Design

The extension sends a structured prompt instructing the AI to return a JSON object with:

```json
{
  "summary": ["bullet 1", "bullet 2", ...],
  "keyInsights": ["insight 1", ...],
  "readingTime": "4 min read",
  "wordCount": 850,
  "sentiment": "positive",
  "topics": ["Technology", "AI"]
}
```

Page content is truncated to ~2,500 characters before sending to stay well within free tier token limits. Output is set to 2,048 tokens max.

---

## Security Decisions

### API Key Storage

- The API key is stored in `chrome.storage.local` — device-local, not synced to the cloud
- The key **only exists in `background.js`** (the service worker)
- `popup.js` and `content.js` **never receive or handle the API key**
- The settings UI clears the key input field on open (no pre-filling)

### No Exposed Secrets

- No API keys are hardcoded anywhere in the source
- No API keys are committed to the repository
- The key is never logged to the console

### Message Validation

- The background worker validates the sender of every message (`isValidSender()`)
- Only messages from the extension's own pages or content scripts are processed

### XSS Prevention

- All AI response strings are sanitized via `sanitize()` before being stored or returned
- The popup renders content using `textContent` / sanitized strings — no raw HTML from AI output

### Content Security Policy

- Extension pages enforce `script-src 'self'` — no inline scripts or remote script loading

### Minimal Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the current tab's URL and inject content scripts |
| `scripting` | Programmatically inject content.js if not already loaded |
| `storage` | Store API key, settings, and summary cache locally |
| `host_permissions: generativelanguage.googleapis.com` | Allow background worker to call Gemini API |

---

## Trade-offs

| Decision | Trade-off 
|---|---|
| **Background-only API calls** | More secure but adds a round-trip message hop vs. calling from popup directly |
| **Content truncation at 2,500 chars** | Keeps API costs low and avoids free-tier token limits. Sufficient for article summaries. |
| **30-minute cache TTL** | Balances freshness vs. API usage — live news pages may serve stale summaries |
| **Heuristic content extraction** | Works on most sites without a library, but may not be as accurate as full Readability.js on unusual layouts |
| **Gemini as default** | Free tier makes it accessible for all users, but OpenAI may produce better results on some content |
| **Local storage only** | Keeps the user's data private, but summaries don't sync across devices |

---

## Troubleshooting

**"Not enough readable content found"**
→ The page may be behind a login, a dynamic SPA that hasn't loaded, or mostly image-based. Try scrolling the page fully before summarizing.

**"Invalid API key"**
→ Double-check your key in Settings. For Gemini, ensure the key is enabled for the Generative Language API at [Google AI Studio](https://aistudio.google.com).

**"Rate limit exceeded"**
→ You've hit the API's per-minute limit. Wait 30–60 seconds and try again.

**Extension not appearing**
→ Ensure Developer Mode is enabled in `chrome://extensions` and the folder was loaded correctly (it should contain `manifest.json`).

---

## Development

To make changes:

1. Edit the source files
2. Go to `chrome://extensions`
3. Click the **🔄 Reload** button on the SummAI card
4. Re-open the popup to test

---

## License

---

https://github.com/Bigoluwagentle/aipagesummarizer.git

