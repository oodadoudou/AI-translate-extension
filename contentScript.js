(function () {
  const STORAGE_KEY = "aiTranslateConfig";
  const DEFAULT_STATE = {
    enabled: true,
    targetLanguage: "Simplified Chinese",
    autoDetect: true,
    sourceLanguage: "",
  };

  let state = { ...DEFAULT_STATE };
  let debounceId = null;
  let lastText = "";
  let lastResult = null;
  let overlayHost = null;
  let lastRect = null;
  let isManuallyPositioned = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartLeft = 0;
  let dragStartTop = 0;

  bootstrap();

  function bootstrap() {
    requestInitialState();
    chrome.storage.onChanged.addListener(handleStorageChange);
    document.addEventListener("mouseup", handleSelectionEvent);
    document.addEventListener("keyup", handleSelectionEvent);
    document.addEventListener("selectionchange", handleSelectionEvent);
    document.addEventListener("keydown", handleEscape, true);
    window.addEventListener("scroll", handleScroll, true);
    document.addEventListener("mousedown", handleOutsideClick, true);
    chrome.runtime.onMessage.addListener(handleContentMessage);
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "sync" && areaName !== "local") return;
    if (!changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue || {};
    state = {
      ...state,
      ...next,
    };
    lastText = "";
    if (!state.enabled) {
      removeOverlay();
    }
  }

  function requestInitialState() {
    sendMessage({ type: "GET_STATE" }).then((response) => {
      if (response && response.ok && response.state) {
        state = { ...state, ...response.state };
      }
    });
  }

  function handleSelectionEvent() {
    if (debounceId) clearTimeout(debounceId);
    debounceId = setTimeout(checkSelection, 800);
  }

  function checkSelection() {
    if (!state.enabled) {
      removeOverlay();
      return;
    }

    const { text, rect } = getSelectionDetails();
    if (!text) {
      return;
    }

    lastRect = rect;

    if (text === lastText && lastResult) {
      renderOverlay(rect, {
        mode: "result",
        result: lastResult,
      });
      return;
    }

    lastText = text;
    lastResult = null;
    isManuallyPositioned = false;
    requestTranslation(text, rect);
  }

  function getSelectionDetails() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0)
      return { text: "", rect: null };
    const text = selection.toString().trim();
    if (!text) return { text: "", rect: null };
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    return { text, rect };
  }

  function requestTranslation(text, rect) {
    if (!state.enabled) return;

    renderOverlay(rect, { mode: "loading" });

    const port = chrome.runtime.connect({ name: "translate_stream" });
    let fullText = "";
    let detectedLang = state.autoDetect
      ? "Auto"
      : state.sourceLanguage || "unknown";
    let finished = false;

    const handleDisconnect = () => {
      if (finished) return;
      const runtimeError = chrome.runtime.lastError;
      const message =
        runtimeError?.message || "Translation channel closed before finishing.";
      renderOverlay(rect, {
        mode: "error",
        message,
        retryText: text,
      });
    };

    const markFinished = () => {
      if (finished) return;
      finished = true;
      port.onDisconnect.removeListener(handleDisconnect);
    };

    port.onDisconnect.addListener(handleDisconnect);

    port.onMessage.addListener((msg) => {
      if (!state.enabled) {
        markFinished();
        port.disconnect();
        removeOverlay();
        return;
      }

      if (msg.type === "CHUNK") {
        fullText += msg.value;
        lastResult = {
          translatedText: fullText,
          detectedSourceLanguage: detectedLang, // 'unknown' or preset
          targetLanguage: state.targetLanguage,
        };
        renderOverlay(rect, { mode: "result", result: lastResult });
      } else if (msg.type === "DONE") {
        markFinished();
        port.disconnect();
        lastResult = {
          translatedText: fullText,
          detectedSourceLanguage: detectedLang,
          targetLanguage: state.targetLanguage,
        };
        renderOverlay(rect, { mode: "result", result: lastResult });
      } else if (msg.type === "ERROR") {
        markFinished();
        port.disconnect();
        renderOverlay(rect, {
          mode: "error",
          message: msg.error || "Translation failed.",
          retryText: text,
        });
      }
    });

    port.postMessage({ type: "START_STREAM", text });
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }
        resolve(response);
      });
    });
  }

  function handleEscape(event) {
    if (event.key === "Escape") {
      removeOverlay();
    }
  }

  function handleScroll() {
    if (overlayHost && lastRect && !isManuallyPositioned) {
      const popover = overlayHost.shadowRoot.querySelector(".popover");
      const caret = overlayHost.shadowRoot.querySelector(".caret");

      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const newRect = range.getBoundingClientRect();
        positionOverlay(popover, caret, newRect);
      }
    }
  }

  function onDragMove(e) {
    if (!overlayHost) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    overlayHost.style.left = `${dragStartLeft + dx}px`;
    overlayHost.style.top = `${dragStartTop + dy}px`;

    const caret = overlayHost.shadowRoot.querySelector(".caret");
    if (caret) caret.style.display = "none";
  }

  function onDragEnd() {
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }

  function startDrag(e) {
    if (
      e.target.closest("button") ||
      e.target.closest(".lang-selector") ||
      e.target.closest(".translated-text")
    ) {
      return;
    }

    e.preventDefault();
    isManuallyPositioned = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const rect = overlayHost.getBoundingClientRect();
    dragStartLeft = rect.left;
    dragStartTop = rect.top;

    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  }

  function handleOutsideClick(event) {
    if (!overlayHost) return;
    if (!overlayHost.contains(event.target)) {
      removeOverlay();
    }
  }

  function removeOverlay() {
    if (overlayHost && overlayHost.parentNode) {
      overlayHost.parentNode.removeChild(overlayHost);
    }
    overlayHost = null;
    isManuallyPositioned = false;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }

  function renderOverlay(rect, state) {
    if (!overlayHost) {
      overlayHost = document.createElement("div");
      overlayHost.style.position = "fixed";
      overlayHost.style.zIndex = "2147483647";
      overlayHost.style.pointerEvents = "none";
      overlayHost.attachShadow({ mode: "open" });
      document.body.appendChild(overlayHost);
    }

    const shadow = overlayHost.shadowRoot;
    const { mode } = state;

    const style = `
      :host {
        font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        line-height: 20px;
        color: #3c4043;
      }
      .popover {
        background: #fff;
        border-radius: 8px;
        box-shadow: 0 1px 3px rgba(60,64,67,0.3), 0 4px 8px 3px rgba(60,64,67,0.15);
        display: flex;
        flex-direction: column;
        min-width: 300px;
        max-width: 800px;
        width: max-content;
        max-height: 60vh;
        overflow-y: auto;
        position: relative;
        pointer-events: auto;
      }
      .caret {
        position: absolute;
        width: 16px;
        height: 16px;
        background: #fff;
        transform: rotate(45deg);
        box-shadow: 1px 1px 1px rgba(60,64,67,0.0);
        z-index: -1;
      }
      .caret-top {
        top: -6px;
        left: 50%;
        margin-left: -8px;
        box-shadow: -1px -1px 1px rgba(60,64,67,0.05);
      }
      .caret-bottom {
        bottom: -6px;
        left: 50%;
        margin-left: -8px;
        box-shadow: 2px 2px 2px rgba(60,64,67,0.1);
      }
      .header {
        display: flex;
        align-items: center;
        padding: 8px 12px;
        border-bottom: 1px solid #f1f3f4;
        background: #f8f9fa;
        border-radius: 8px 8px 0 0;
        justify-content: space-between;
        cursor: grab;
      }
      .header:active {
        cursor: grabbing;
      }
      .lang-selector {
        font-size: 13px;
        color: #5f6368;
        background: transparent;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .close-btn {
        cursor: pointer;
        width: 20px;
        height: 20px;
        opacity: 0.5;
        border: none;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .close-btn:hover { opacity: 1; }
      .close-btn svg { width: 12px; height: 12px; fill: #5f6368; }
      .content {
        padding: 12px;
      }
      .translated-text {
        font-size: 18px;
        line-height: 24px;
        color: #202124;
        white-space: pre-wrap;
      }
      .footer {
        padding: 8px 12px;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      button.action-btn {
        background: transparent;
        border: none;
        color: #1a73e8;
        font-weight: 500;
        font-size: 13px;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.1s;
      }
      button.action-btn:hover { background: #f6fafe; }
      .loading { color: #5f6368; display: flex; align-items: center; gap: 8px; padding: 12px; cursor: grab; }
      .loading:active { cursor: grabbing; }
      .spinner {
        width: 16px; height: 16px;
        border: 2px solid #1a73e8;
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
      .error { color: #d93025; padding: 12px; }
      @keyframes spin { to { transform: rotate(360deg); } }
    `;

    const closeIcon = `<svg viewBox="0 0 14 14"><path d="M14 1.41L12.59 0L7 5.59L1.41 0L0 1.41L5.59 7L0 12.59L1.41 14L7 8.41L12.59 14L14 12.59L8.41 7z"/></svg>`;

    const content = (() => {
      if (mode === "loading") {
        return `
          <div class="popover">
            <div class="caret caret-top"></div>
            <div class="loading"><span class="spinner"></span>Translating...</div>
          </div>
        `;
      }
      if (mode === "error") {
        return `
          <div class="popover">
            <div class="caret caret-top"></div>
            <div class="header">
              <span>Error</span>
              <button class="close-btn" id="close">${closeIcon}</button>
            </div>
            <div class="error">${escapeHtml(state.message || "Error details unknown")}</div>
            <div class="footer">
              <button class="action-btn" id="retry">Try again</button>
            </div>
          </div>
        `;
      }
      if (mode === "result" && state.result) {
        const { translatedText, targetLanguage } = state.result;
        return `
          <div class="popover">
            <div class="caret caret-top"></div>
            <div class="header">
               <div class="lang-selector">${escapeHtml(targetLanguage || "Target Language")}</div>
               <button class="close-btn" id="close">${closeIcon}</button>
            </div>
            <div class="content">
              <div class="translated-text">${escapeHtml(translatedText)}</div>
            </div>
            <div class="footer">
              <button class="action-btn" id="copy">Copy</button>
            </div>
          </div>
        `;
      }
      return "";
    })();

    shadow.innerHTML = `<style>${style}</style>${content}`;

    const popoverDiv = shadow.querySelector(".popover");
    const caretDiv = shadow.querySelector(".caret");

    if (!isManuallyPositioned) {
      positionOverlay(popoverDiv, caretDiv, rect);
    } else {
      if (caretDiv) caretDiv.style.display = "none";
    }

    if (popoverDiv) {
      popoverDiv.addEventListener("mousedown", startDrag);
    }

    const copyButton = shadow.getElementById("copy");
    if (copyButton && state.result) {
      copyButton.addEventListener("click", () =>
        copyText(state.result.translatedText),
      );
    }
    const closeButton = shadow.getElementById("close");
    if (closeButton) {
      closeButton.addEventListener("click", removeOverlay);
    }
    const retryButton = shadow.getElementById("retry");
    if (retryButton && state.retryText) {
      retryButton.addEventListener("click", () =>
        requestTranslation(state.retryText, rect),
      );
    }
  }

  function positionOverlay(popover, caret, rect) {
    if (!popover || !rect) return;

    const spacing = 10;
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;

    requestAnimationFrame(() => {
      const pRect = popover.getBoundingClientRect();
      const w = pRect.width;
      const h = pRect.height;

      const center = rect.left + rect.width / 2;

      let left = center - w / 2;
      let top = rect.bottom + spacing;
      let pointingUp = true;

      if (top + h + spacing > viewportH) {
        const topAbove = rect.top - h - spacing;
        if (topAbove > 0) {
          top = topAbove;
          pointingUp = false;
        }
      }

      if (left < 10) left = 10;
      if (left + w > viewportW - 10) left = viewportW - w - 10;

      overlayHost.style.left = `${left}px`;
      overlayHost.style.top = `${top}px`;

      if (caret) {
        caret.className = pointingUp ? "caret caret-top" : "caret caret-bottom";
        const relativeCenter = center - left;
        const safeMargin = 16;
        const clampedCenter = Math.max(
          safeMargin,
          Math.min(w - safeMargin, relativeCenter),
        );
        caret.style.left = `${clampedCenter}px`;
      }
    });
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("Copy failed", error);
    }
  }

  function escapeHtml(value) {
    if (!value) return "";
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  function handleContentMessage(message, sender, sendResponse) {
    if (message.type === "TRANSLATE_PAGE") {
      PageTranslator.toggle();
      sendResponse({ ok: true });
    }
  }

  const PageTranslator = (() => {
    let isActive = false;
    let nodeMap = new Map();
    let translatedMap = new Map();
    let toggleBtn = null;

    function readPageConcurrency() {
      return new Promise((resolve) => {
        const areas = [chrome.storage.sync, chrome.storage.local].filter(
          Boolean,
        );
        const tryNext = (i) => {
          if (i >= areas.length) {
            resolve(10);
            return;
          }
          areas[i].get([STORAGE_KEY], (result) => {
            const val = result?.[STORAGE_KEY]?.concurrency;
            if (val != null && !chrome.runtime.lastError)
              resolve(Math.max(1, Math.min(50, val)));
            else tryNext(i + 1);
          });
        };
        tryNext(0);
      });
    }

    async function toggle() {
      if (!toggleBtn) createToggleUI();

      if (isActive) {
        restoreOriginal();
        isActive = false;
        updateToggleUI("Original");
      } else {
        updateToggleUI("Translating...");
        try {
          const concurrency = await readPageConcurrency();
          await translatePage(concurrency);
          isActive = true;
          updateToggleUI("Translated");
        } catch (error) {
          console.error("Page translation failed", error);
          isActive = false;
          updateToggleUI("Translation failed");
          setTimeout(() => updateToggleUI("Original"), 2000);
        }
      }
    }

    function createToggleUI() {
      const div = document.createElement("div");
      div.id = "ai-translate-page-toggle";
      div.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483647;
        background: #fff;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        border-radius: 24px;
        padding: 8px 16px;
        font-family: sans-serif;
        font-size: 14px;
        color: #333;
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        border: 1px solid #ddd;
        transition: transform 0.2s;
      `;
      div.innerHTML = `
        <span id="status-text">Original</span>
      `;
      div.onclick = toggle;
      document.body.appendChild(div);
      toggleBtn = div;
    }

    function updateToggleUI(text) {
      if (toggleBtn) {
        toggleBtn.querySelector("#status-text").textContent = text;
      }
    }

    function restoreOriginal() {
      for (const [node, original] of nodeMap) {
        node.nodeValue = original;
      }
    }

    async function translatePage(concurrency) {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            if (
              node.parentElement &&
              ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"].includes(
                node.parentElement.tagName,
              )
            )
              return NodeFilter.FILTER_REJECT;
            if (node.parentElement && node.parentElement.isContentEditable)
              return NodeFilter.FILTER_REJECT;
            if (node.parentElement && node.parentElement.offsetParent === null)
              return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );

      const nodesToTranslate = [];
      let currentNode;
      while ((currentNode = walker.nextNode())) {
        nodesToTranslate.push(currentNode);
      }

      // Viewport-first: sort visible nodes to the front so they translate first
      const vh = window.innerHeight;
      nodesToTranslate.sort((a, b) => {
        const ra = a.parentElement?.getBoundingClientRect();
        const rb = b.parentElement?.getBoundingClientRect();
        const aVis = ra && ra.top < vh && ra.bottom > 0 ? 0 : 1;
        const bVis = rb && rb.top < vh && rb.bottom > 0 ? 0 : 1;
        return aVis - bVis;
      });

      const batchSize = 20;
      const batches = [];
      let currentBatch = [];
      let segmentsNeedingTranslation = 0;

      for (const node of nodesToTranslate) {
        const text = node.nodeValue.trim();
        if (!nodeMap.has(node)) {
          nodeMap.set(node, node.nodeValue);
        }

        if (translatedMap.has(text)) {
          node.nodeValue = node.nodeValue.replace(
            text,
            translatedMap.get(text),
          );
        } else {
          currentBatch.push({ node, text });
          segmentsNeedingTranslation++;
          if (currentBatch.length >= batchSize) {
            batches.push(currentBatch);
            currentBatch = [];
          }
        }
      }
      if (currentBatch.length) batches.push(currentBatch);

      if (!batches.length || segmentsNeedingTranslation === 0) {
        updateToggleUI("Translated");
        return;
      }

      const concurrencyLimit = Math.min(concurrency || 10, batches.length);
      let completedSegments = 0;

      const reportProgress = () => {
        completedSegments++;
        updateToggleUI(
          `Translating... (${completedSegments}/${segmentsNeedingTranslation})`,
        );
      };

      updateToggleUI(`Translating... (0/${segmentsNeedingTranslation})`);
      const initialResult = await runBatchesWithConcurrency(
        batches,
        concurrencyLimit || 1,
        reportProgress,
      );
      let totalCompleted = initialResult.completed;

      if (initialResult.failedBatches.length) {
        console.warn(
          "Retrying failed batches sequentially",
          initialResult.failedBatches.length,
        );
        const retryResult = await runBatchesWithConcurrency(
          initialResult.failedBatches,
          1,
          reportProgress,
        );
        totalCompleted += retryResult.completed;

        if (retryResult.failedBatches.length) {
          throw new Error("Some segments failed to translate");
        }
      }

      if (!totalCompleted) {
        throw new Error("Translation did not apply to any segments");
      }
    }

    async function runBatchesWithConcurrency(batches, limit, onProgress) {
      let cursor = 0;
      let completed = 0;
      const failedBatches = [];
      const workers = Array.from({ length: Math.max(1, limit) }, () =>
        worker(),
      );
      await Promise.all(workers);
      return { completed, failedBatches };

      async function worker() {
        while (true) {
          const index = cursor++;
          if (index >= batches.length) break;
          const batch = batches[index];
          const unresolved = await processBatch(batch, () => {
            completed++;
            if (onProgress) onProgress();
          });
          if (unresolved.length) {
            failedBatches.push(unresolved);
          }
        }
      }
    }

    async function processBatch(batch, onProgress) {
      const texts = batch.map((item) => item.text);
      try {
        const response = await sendMessage({ type: "TRANSLATE_BATCH", texts });
        if (!response || !response.ok || !Array.isArray(response.result)) {
          return batch;
        }

        const translations = response.result;
        const unresolved = [];
        const writes = [];
        batch.forEach((item, index) => {
          const translated = translations[index];
          if (translated) {
            translatedMap.set(item.text, translated);
            writes.push({ node: item.node, original: item.text, translated });
            if (onProgress) onProgress();
          } else {
            unresolved.push(item);
          }
        });
        // Batch all DOM writes in a single animation frame to avoid reflow thrashing
        if (writes.length) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => {
              writes.forEach(({ node, original, translated }) => {
                node.nodeValue = node.nodeValue.replace(original, translated);
              });
              resolve();
            }),
          );
        }
        return unresolved;
      } catch (error) {
        console.error("Batch translation failed", error);
        return batch;
      }
    }

    return { toggle };
  })();
})();
