/**
 * content.js — Content Script
 * Extracts meaningful, readable content from the current page.
 * Runs in the page context but communicates only with the background worker.
 */

(function () {
  "use strict";

  // ─── Message Listener ─────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "EXTRACT_CONTENT") {
      try {
        const extracted = extractPageContent();
        sendResponse({ success: true, ...extracted });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false; // synchronous
    }
  });

  // ─── Main Extractor ───────────────────────────────────────────────────────────
  function extractPageContent() {
    const title = document.title || "Untitled Page";
    const url = window.location.href;

    // Try to find main article content via heuristics
    const mainContent = findMainContent();
    const text = cleanText(mainContent);
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    return {
      title,
      url,
      content: text,
      wordCount,
      lang: document.documentElement.lang || "en",
    };
  }

  // ─── Content Detection Heuristics ─────────────────────────────────────────────
  function findMainContent() {
    // Priority 1: Semantic article element
    const article = document.querySelector("article");
    if (article && textLength(article) > 200) return article;

    // Priority 2: main element
    const main = document.querySelector("main");
    if (main && textLength(main) > 200) return main;

    // Priority 3: Common content selectors used by major sites
    const contentSelectors = [
      '[role="main"]',
      ".post-content",
      ".article-content",
      ".article-body",
      ".entry-content",
      ".post-body",
      ".content-body",
      ".story-body",
      ".story-content",
      "#content",
      "#main-content",
      "#article-body",
      ".c-article-body",
      ".article__body",
      ".post__content",
      ".blog-post",
      ".prose",
      ".markdown-body",
      ".gh-content",
      ".post-full-content",
    ];

    for (const selector of contentSelectors) {
      const el = document.querySelector(selector);
      if (el && textLength(el) > 200) return el;
    }

    // Priority 4: Score-based heuristic — find the div with most paragraph text
    return scoreBasedExtraction();
  }

  // ─── Score-based Extraction ────────────────────────────────────────────────────
  function scoreBasedExtraction() {
    const candidates = [];
    const elements = document.querySelectorAll("div, section, td");

    elements.forEach((el) => {
      // Skip known noise elements
      if (isNoise(el)) return;

      const paragraphs = el.querySelectorAll("p");
      if (paragraphs.length < 2) return;

      let score = 0;
      let charCount = 0;

      paragraphs.forEach((p) => {
        const text = p.textContent.trim();
        if (text.length > 50) {
          score += 1;
          charCount += text.length;
        }
      });

      // Penalize for link density (nav/sidebar-heavy areas)
      const links = el.querySelectorAll("a");
      const linkText = Array.from(links).reduce((s, a) => s + a.textContent.length, 0);
      const totalText = el.textContent.length;
      const linkDensity = totalText > 0 ? linkText / totalText : 0;

      score = score * (1 - linkDensity * 0.7);

      if (score > 2 && charCount > 300) {
        candidates.push({ el, score, charCount });
      }
    });

    if (candidates.length === 0) {
      // Fallback: return body but strip noise
      return document.body;
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score || b.charCount - a.charCount);
    return candidates[0].el;
  }

  // ─── Noise Detector ───────────────────────────────────────────────────────────
  function isNoise(el) {
    const noiseSelectors = [
      "nav",
      "header",
      "footer",
      "aside",
      ".sidebar",
      ".navigation",
      ".nav",
      ".menu",
      ".header",
      ".footer",
      ".advertisement",
      ".ad",
      ".ads",
      ".social",
      ".share",
      ".comments",
      ".comment-section",
      ".related",
      ".recommended",
      ".newsletter",
      ".subscribe",
      ".cookie",
      ".popup",
      ".modal",
      ".overlay",
      '[role="navigation"]',
      '[role="banner"]',
      '[role="contentinfo"]',
      '[role="complementary"]',
    ];

    for (const sel of noiseSelectors) {
      if (el.matches && el.matches(sel)) return true;
      if (el.closest && el.closest(sel)) return true;
    }

    return false;
  }

  // ─── Text Utilities ───────────────────────────────────────────────────────────
  function textLength(el) {
    return el.textContent.trim().length;
  }

  function cleanText(el) {
    // Clone to avoid mutating DOM
    const clone = el.cloneNode(true);

    // Remove noise child elements from the clone
    const noiseTagsAndSelectors = [
      "script", "style", "noscript", "iframe", "svg",
      "nav", "header", "footer", "aside",
      ".sidebar", ".ad", ".advertisement", ".social-share",
      ".comments", ".related-posts", ".newsletter-signup",
      '[role="navigation"]', '[role="banner"]',
    ];

    noiseTagsAndSelectors.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((n) => n.remove());
    });

    // Extract text, preserving newlines for readability
    let text = "";
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);

    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;

      const tag = parent.tagName.toLowerCase();
      const trimmed = node.textContent.trim();
      if (!trimmed) continue;

      // Add paragraph/heading breaks
      if (["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "td", "th"].includes(tag)) {
        text += trimmed + "\n";
      } else {
        text += trimmed + " ";
      }
    }

    // Normalize whitespace
    return text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 15000); // Limit to prevent huge payloads
  }
})();
