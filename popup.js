"use strict";

const $ = (id) => document.getElementById(id);

const pageTitle    = $("pageTitle");
const pageFavicon  = $("pageFavicon");
const ctaZone      = $("ctaZone");
const loadingZone  = $("loadingZone");
const loadingText  = $("loadingText");
const loadingBar   = $("loadingBarFill");
const errorZone    = $("errorZone");
const errorText    = $("errorText");
const resultsZone  = $("resultsZone");

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
const goToSettingsBtn = $("goToSettingsBtn");
const copyBtn         = $("copyBtn");
const refreshBtn      = $("refreshBtn");
const clearBtn        = $("clearBtn");
const settingsBtn     = $("settingsBtn");
const themeToggle     = $("themeToggle");
const themeIconDark   = $("themeIconDark");
const themeIconLight  = $("themeIconLight");

const settingsView    = $("settingsView");
const mainView        = $("app");
const backBtn         = $("backBtn");
const providerSelect  = $("providerSelect");
const apiKeyInput     = $("apiKeyInput");
const revealKey       = $("revealKey");
const saveSettingsBtn = $("saveSettingsBtn");
const saveStatus      = $("saveStatus");
const keyStatusText   = $("keyStatusText");
const clearAllCacheBtn= $("clearAllCacheBtn");
const geminiLink      = $("geminiLink");
const openaiLink      = $("openaiLink");
const toast           = $("toast");

let currentState = "idle";
let currentTab   = null;
let lastSummary  = null;

document.addEventListener("DOMContentLoaded", async () => {
  await loadTheme();
  await loadCurrentTab();
  await loadSettingsState();
  bindEvents();
});

async function loadTheme() {
  const result = await storageGet(["theme"]);
  applyTheme(result.theme || "dark");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  if (theme === "dark") {
    themeIconDark.classList.remove("hidden");
    themeIconLight.classList.add("hidden");
  } else {
    themeIconDark.classList.add("hidden");
    themeIconLight.classList.remove("hidden");
  }
}

async function loadCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;
    if (tab) {
      pageTitle.textContent = tab.title || tab.url || "Untitled Page";
      if (tab.favIconUrl) {
        const img = document.createElement("img");
        img.src    = tab.favIconUrl;
        img.width  = 18;
        img.height = 18;
        img.className = "favicon-img"; 
        img.onerror = () => { pageFavicon.textContent = "🌐"; };
        pageFavicon.innerHTML = "";
        pageFavicon.appendChild(img);
      }
    }
  } catch {
    pageTitle.textContent = "Unable to read page info";
  }
}

async function loadSettingsState() {
  const resp = await sendToBackground({ type: "GET_SETTINGS" });
  if (resp?.settings) {
    providerSelect.value = resp.settings.apiProvider || "gemini";
    updateProviderLinks(resp.settings.apiProvider || "gemini");
    if (resp.settings.hasApiKey) {
      keyStatusText.textContent = "✓ API key is saved.";
    } else {
      keyStatusText.textContent = "No API key saved yet. Add one below.";
    }
  }
}

function bindEvents() {
  summarizeBtn.addEventListener("click", () => runSummarize(false));
  retryBtn.addEventListener("click",     () => runSummarize(false));
  refreshBtn.addEventListener("click",   () => runSummarize(true));
  goToSettingsBtn.addEventListener("click", showSettings);
  clearBtn.addEventListener("click",    clearResults);
  copyBtn.addEventListener("click",     copySummary);
  settingsBtn.addEventListener("click", showSettings);
  backBtn.addEventListener("click",     hideSettings);
  saveSettingsBtn.addEventListener("click", saveSettings);
  clearAllCacheBtn.addEventListener("click", clearAllCache);
  themeToggle.addEventListener("click", toggleTheme);
  revealKey.addEventListener("click",   toggleRevealKey);
  providerSelect.addEventListener("change", () => updateProviderLinks(providerSelect.value));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !settingsView.classList.contains("hidden")) hideSettings();
  });
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

    if (!extracted?.success) {
      throw new Error(extracted?.error || "Failed to extract page content.");
    }
    if (!extracted.content || extracted.content.trim().length < 50) {
      throw new Error("Not enough readable content found on this page. Try a news article or blog post.");
    }

    setLoadingStep(2, "Contacting Gemini AI… (may take up to 30s)");

    if (refresh) {
      await sendToBackground({ type: "CLEAR_CACHE", payload: { url: extracted.url } });
    }

    const resp = await sendToBackground({
      type: "SUMMARIZE_PAGE",
      payload: { url: extracted.url, content: extracted.content, title: extracted.title },
    });

    setLoadingStep(3, "Rendering summary…");

    if (!resp?.success) {
      showError(resp?.error || "Failed to generate summary.", resp?.needsSetup);
      return;
    }

    lastSummary = resp.summary;
    renderResults(resp.summary, resp.fromCache);
    setState("results");
  } catch (err) {
    showError(err.message || "An unexpected error occurred.");
  }
}

function setLoadingStep(step, text) {
  loadingText.textContent = text;
  loadingBar.style.width = `${(step / 3) * 100}%`;
}

function renderResults(summary, fromCache) {
  readingTimeText.textContent = summary.readingTime || "—";
  wordCountText.textContent   = summary.wordCount
    ? `${summary.wordCount.toLocaleString()} words` : "—";

  if (fromCache) {
    cacheBadge.classList.remove("hidden");
  } else {
    cacheBadge.classList.add("hidden");
  }

  const sentimentMap = {
    positive: { icon: "😊", label: "Positive" },
    negative: { icon: "😟", label: "Negative" },
    mixed:    { icon: "🤔", label: "Mixed" },
    neutral:  { icon: "😐", label: "Neutral" },
  };
  const s = sentimentMap[summary.sentiment] || sentimentMap.neutral;
  sentimentIcon.textContent = s.icon;
  sentimentText.textContent = s.label;
  sentimentPill.dataset.sentiment = summary.sentiment || "neutral";

  if (summary.topics?.length) {
    topicsList.innerHTML = summary.topics
      .map(t => `<span class="topic-tag">${t}</span>`).join("");
    topicsRow.classList.remove("hidden");
  } else {
    topicsRow.classList.add("hidden");
  }

  summaryList.innerHTML = summary.summary
    .map(item => `<li>${item}</li>`).join("");

  insightsList.innerHTML = summary.keyInsights
    .map(item => `<li>${item}</li>`).join("");
}

function setState(state) {
  currentState = state;

  const zones = { ctaZone, loadingZone, errorZone, resultsZone };
  Object.entries(zones).forEach(([name, el]) => {
    const zoneKey = name.replace("Zone", "").replace("Cta", "idle");
    if (
      (state === "idle"    && name === "ctaZone")     ||
      (state === "loading" && name === "loadingZone") ||
      (state === "error"   && name === "errorZone")   ||
      (state === "results" && name === "resultsZone")
    ) {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  });

  if (state === "loading") {
    loadingBar.style.width = "0%";
  }
}

function showError(message, needsSetup = false) {
  errorText.textContent = message;
  if (needsSetup) {
    goToSettingsBtn.classList.remove("hidden");
  } else {
    goToSettingsBtn.classList.add("hidden");
  }
  setState("error");
}

function clearResults() {
  lastSummary = null;
  setState("idle");
}

async function copySummary() {
  if (!lastSummary) return;
  const title = currentTab?.title || "Page Summary";
  const lines = [
    `# ${title}`,
    `Reading time: ${lastSummary.readingTime} | Words: ${lastSummary.wordCount?.toLocaleString()}`,
    "",
    "## Summary",
    ...lastSummary.summary.map(s => `• ${s}`),
    "",
    "## Key Insights",
    ...lastSummary.keyInsights.map((k, i) => `${i + 1}. ${k}`),
  ];
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    showToast("✓ Copied to clipboard");
  } catch {
    showToast("Copy failed — please try again");
  }
}

async function showSettings() {
  mainView.classList.add("hidden");
  settingsView.classList.remove("hidden");
  apiKeyInput.value = "";
  apiKeyInput.placeholder = "Paste new key here (leave blank to keep current)";
  await loadSettingsState();
}

function hideSettings() {
  settingsView.classList.add("hidden");
  mainView.classList.remove("hidden");
}

async function saveSettings() {
  const apiKey   = apiKeyInput.value.trim();
  const provider = providerSelect.value;

  if (!apiKey) {
    const resp = await sendToBackground({ type: "SAVE_SETTINGS", payload: { apiProvider: provider } });
    showSaveStatus(resp?.success, "Provider saved!", resp?.error);
    return;
  }

  saveSettingsBtn.disabled = true;
  const resp = await sendToBackground({
    type: "SAVE_SETTINGS",
    payload: { apiKey, apiProvider: provider },
  });
  saveSettingsBtn.disabled = false;

  if (resp?.success) {
    apiKeyInput.value = "";
    keyStatusText.textContent = "✓ API key is saved.";
    showSaveStatus(true, "✓ API key saved successfully!");
  } else {
    showSaveStatus(false, null, resp?.error);
  }
}

function showSaveStatus(success, okMsg, errMsg) {
  saveStatus.textContent = success ? (okMsg || "✓ Saved!") : (errMsg || "Failed to save.");
  saveStatus.className = "save-status " + (success ? "success" : "error");
  setTimeout(() => { saveStatus.textContent = ""; saveStatus.className = "save-status"; }, 3000);
}

async function clearAllCache() {
  clearAllCacheBtn.disabled = true;
  clearAllCacheBtn.textContent = "Clearing…";
  await sendToBackground({ type: "CLEAR_CACHE" });
  clearAllCacheBtn.disabled = false;
  clearAllCacheBtn.textContent = "Clear All Cached Summaries";
  showToast("✓ Cache cleared");
}

async function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  await sendToBackground({ type: "SAVE_SETTINGS", payload: { theme: next } });
}

function updateProviderLinks(provider) {
  if (provider === "gemini") {
    geminiLink.classList.remove("hidden");
    openaiLink.classList.add("hidden");
  } else {
    geminiLink.classList.add("hidden");
    openaiLink.classList.remove("hidden");
  }
}

function toggleRevealKey() {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
}

let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function sendToBackground(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Popup] Message error:", chrome.runtime.lastError.message);
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      resolve({ error: err.message });
    }
  });
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result));
  });
}
