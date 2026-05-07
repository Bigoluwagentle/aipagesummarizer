/**
 * popup.js — No API key needed. Works out of the box.
 */
"use strict";

const $ = (id) => document.getElementById(id);

const pageTitle       = $("pageTitle");
const pageFavicon     = $("pageFavicon");
const ctaZone         = $("ctaZone");
const loadingZone     = $("loadingZone");
const loadingText     = $("loadingText");
const loadingBar      = $("loadingBarFill");
const errorZone       = $("errorZone");
const errorText       = $("errorText");
const resultsZone     = $("resultsZone");
const readingTimeText = $("readingTimeText");
const wordCountText   = $("wordCountText");
const sentimentPill   = $("sentimentPill");
const sentimentIcon   = $("sentimentIcon");
const sentimentText   = $("sentimentText");
const cacheBadge      = $("cacheBadge");
const topicsRow       = $("topicsRow");
const topicsList      = $("topicsList");
const summaryList     = $("summaryList");
const insightsList    = $("insightsList");
const summarizeBtn    = $("summarizeBtn");
const retryBtn        = $("retryBtn");
const copyBtn         = $("copyBtn");
const refreshBtn      = $("refreshBtn");
const clearBtn        = $("clearBtn");
const themeToggle     = $("themeToggle");
const themeIconDark   = $("themeIconDark");
const themeIconLight  = $("themeIconLight");
const toast           = $("toast");

let currentTab  = null;
let lastSummary = null;

document.addEventListener("DOMContentLoaded", async () => {
  await loadTheme();
  await loadCurrentTab();
  bindEvents();
});

async function loadTheme() {
  const r = await storageGet(["theme"]);
  applyTheme(r.theme || "dark");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeIconDark.classList.toggle("hidden",  theme === "light");
  themeIconLight.classList.toggle("hidden", theme === "dark");
}

async function loadCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;
    if (tab) {
      pageTitle.textContent = tab.title || tab.url || "Untitled Page";
      if (tab.favIconUrl) {
        const img = document.createElement("img");
        img.src = tab.favIconUrl;
        img.width = 18; img.height = 18;
        img.onerror = () => { pageFavicon.textContent = "🌐"; };
        pageFavicon.innerHTML = "";
        pageFavicon.appendChild(img);
      }
    }
  } catch { pageTitle.textContent = "Unable to read page info"; }
}

function bindEvents() {
  summarizeBtn.addEventListener("click", () => runSummarize(false));
  retryBtn.addEventListener("click",     () => runSummarize(false));
  refreshBtn.addEventListener("click",   () => runSummarize(true));
  clearBtn.addEventListener("click",     clearResults);
  copyBtn.addEventListener("click",      copySummary);
  themeToggle.addEventListener("click",  toggleTheme);
}

async function runSummarize(refresh = false) {
  if (!currentTab) { showError("Cannot access the current tab."); return; }
  setState("loading");
  setLoadingStep(1, "Extracting page content…");

  try {
    let extracted;
    try {
      extracted = await chrome.tabs.sendMessage(currentTab.id, { type: "EXTRACT_CONTENT" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: currentTab.id }, files: ["content.js"] });
      extracted = await chrome.tabs.sendMessage(currentTab.id, { type: "EXTRACT_CONTENT" });
    }

    if (!extracted?.success) throw new Error(extracted?.error || "Failed to extract page content.");
    if (!extracted.content || extracted.content.trim().length < 30) {
      throw new Error("Not enough readable content on this page. Try a news article or blog post.");
    }

    setLoadingStep(2, "Summarizing with AI…");

    if (refresh) {
      await sendToBackground({ type: "CLEAR_CACHE", payload: { url: extracted.url } });
    }

    const resp = await sendToBackground({
      type: "SUMMARIZE_PAGE",
      payload: { url: extracted.url, content: extracted.content, title: extracted.title },
    });

    setLoadingStep(3, "Done!");

    if (!resp?.success) { showError(resp?.error || "Failed to generate summary."); return; }

    lastSummary = resp.summary;
    renderResults(resp.summary, resp.fromCache);
    setState("results");
  } catch (err) {
    showError(err.message || "An unexpected error occurred.");
  }
}

function setLoadingStep(step, text) {
  loadingText.textContent = text;
  loadingBar.style.width  = `${(step / 3) * 100}%`;
}

function renderResults(s, fromCache) {
  readingTimeText.textContent = s.readingTime || "—";
  wordCountText.textContent   = s.wordCount ? `${s.wordCount.toLocaleString()} words` : "—";
  cacheBadge.classList.toggle("hidden", !fromCache);

  const sm = { positive:{ icon:"😊", label:"Positive" }, negative:{ icon:"😟", label:"Negative" }, mixed:{ icon:"🤔", label:"Mixed" }, neutral:{ icon:"😐", label:"Neutral" } };
  const sv = sm[s.sentiment] || sm.neutral;
  sentimentIcon.textContent  = sv.icon;
  sentimentText.textContent  = sv.label;
  sentimentPill.dataset.sentiment = s.sentiment || "neutral";

  if (s.topics?.length) {
    topicsList.innerHTML = s.topics.map(t => `<span class="topic-tag">${t}</span>`).join("");
    topicsRow.classList.remove("hidden");
  } else { topicsRow.classList.add("hidden"); }

  summaryList.innerHTML   = (s.summary || []).map(item => `<li>${item}</li>`).join("");
  insightsList.innerHTML  = (s.keyInsights || []).map(item => `<li>${item}</li>`).join("");
}

function setState(state) {
  ctaZone.classList.toggle("hidden",     state !== "idle");
  loadingZone.classList.toggle("hidden", state !== "loading");
  errorZone.classList.toggle("hidden",   state !== "error");
  resultsZone.classList.toggle("hidden", state !== "results");
  if (state === "loading") loadingBar.style.width = "0%";
}

function showError(msg) {
  errorText.textContent = msg;
  setState("error");
}

function clearResults() { lastSummary = null; setState("idle"); }

async function copySummary() {
  if (!lastSummary) return;
  const lines = [
    `# ${currentTab?.title || "Page Summary"}`,
    "", "## Summary",
    ...(lastSummary.summary || []).map(s => `• ${s}`),
    "", "## Key Insights",
    ...(lastSummary.keyInsights || []).map((k, i) => `${i+1}. ${k}`),
  ];
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    showToast("✓ Copied to clipboard");
  } catch { showToast("Copy failed — try again"); }
}

async function toggleTheme() {
  const curr = document.documentElement.getAttribute("data-theme") || "dark";
  const next = curr === "dark" ? "light" : "dark";
  applyTheme(next);
  await sendToBackground({ type: "SAVE_SETTINGS", payload: { theme: next } });
}

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function sendToBackground(message) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve(response);
      });
    } catch (err) { resolve({ error: err.message }); }
  });
}

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, r => resolve(r)));
}
