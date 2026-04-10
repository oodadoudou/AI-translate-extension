(function () {
  const STORAGE_KEY = "aiTranslateConfig";
  const DEFAULT_STATE = {
    enabled: true,
    targetLanguage: "Simplified Chinese",
    autoDetect: true,
    sourceLanguage: "",
  };

  // ── Utilities ─────────────────────────────────────────────────────────────
  const LONG_TEXT_THRESHOLD = 800;
  const SESSION_CACHE_PREFIX = "tc_";

  function hashText(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return SESSION_CACHE_PREFIX + (h >>> 0).toString(36);
  }

  function estimateTokens(text) {
    return Math.max(1, Math.ceil(text.length / 3.5));
  }

  function readSessionCache(text) {
    return new Promise((resolve) => {
      if (!chrome.storage.session) {
        resolve(null);
        return;
      }
      chrome.storage.session.get([hashText(text)], (result) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(result[hashText(text)] || null);
      });
    });
  }

  function writeSessionCache(text, translation) {
    if (!chrome.storage.session) return;
    chrome.storage.session.set({ [hashText(text)]: translation });
  }
  // ──────────────────────────────────────────────────────────────────────────

  let state = { ...DEFAULT_STATE };
  let debounceId = null;
  let lastText = "";
  let lastResult = null;
  let overlayHost = null;
  let lastRect = null;
  let isManuallyPositioned = false;
  let isPinned = false;
  let currentOverlayMode = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartLeft = 0;
  let dragStartTop = 0;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;

  const sessionHistory = [];

  function addToHistory(entry) {
    const existing = sessionHistory.findIndex(
      (h) => h.originalText === entry.originalText,
    );
    if (existing !== -1) sessionHistory.splice(existing, 1);
    sessionHistory.unshift({ ...entry, timestamp: Date.now() });
    if (sessionHistory.length > 20) sessionHistory.pop();
  }

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

  async function checkSelection() {
    if (!state.enabled) {
      removeOverlay();
      return;
    }

    const { text, rect } = getSelectionDetails();
    if (!text) return;

    lastRect = rect;

    if (text === lastText && lastResult) {
      if (
        currentOverlayMode === "history" ||
        currentOverlayMode === "historyDetail"
      )
        return;
      renderOverlay(rect, { mode: "result", result: lastResult });
      return;
    }

    lastText = text;
    lastResult = null;
    isManuallyPositioned = false;

    // 1. Session cache check — instant, zero tokens
    const cached = await readSessionCache(text);
    if (cached) {
      const result = {
        translatedText: cached,
        targetLanguage: state.targetLanguage,
        tokenEstimate: 0,
        fromCache: true,
        streaming: false,
      };
      lastResult = result;
      addToHistory({
        originalText: text,
        translatedText: cached,
        tokenEstimate: 0,
        fromCache: true,
      });
      renderOverlay(rect, { mode: "result", result });
      return;
    }

    // 2. Long text warning
    if (text.length > LONG_TEXT_THRESHOLD) {
      renderOverlay(rect, { mode: "warning", text, rect });
      return;
    }

    // 3. Translate
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
    let finished = false;

    const handleDisconnect = () => {
      if (finished) return;
      const runtimeError = chrome.runtime.lastError;
      const message =
        runtimeError?.message || "Translation channel closed before finishing.";
      renderOverlay(rect, { mode: "error", message, retryText: text });
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
          targetLanguage: state.targetLanguage,
          tokenEstimate: estimateTokens(text),
          fromCache: false,
          streaming: true,
        };
        renderOverlay(rect, { mode: "result", result: lastResult });
      } else if (msg.type === "DONE") {
        markFinished();
        port.disconnect();
        lastResult = {
          translatedText: fullText,
          targetLanguage: state.targetLanguage,
          tokenEstimate: estimateTokens(text),
          fromCache: false,
          streaming: false,
        };
        writeSessionCache(text, fullText);
        addToHistory({
          originalText: text,
          translatedText: fullText,
          tokenEstimate: estimateTokens(text),
          fromCache: false,
        });
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

  function onResizeMove(e) {
    if (!overlayHost) return;
    const popover = overlayHost.shadowRoot.querySelector(".popover");
    if (!popover) return;
    const dx = e.clientX - resizeStartX;
    const dy = e.clientY - resizeStartY;
    const newW = Math.max(260, resizeStartW + dx);
    const newH = Math.max(80, resizeStartH + dy);
    popover.style.width = `${newW}px`;
    popover.style.maxWidth = "none";
    popover.style.height = `${newH}px`;
  }

  function onResizeEnd() {
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", onResizeEnd);
  }

  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    const popover = overlayHost.shadowRoot.querySelector(".popover");
    if (!popover) return;
    const rect = popover.getBoundingClientRect();
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = rect.width;
    resizeStartH = rect.height;
    document.addEventListener("mousemove", onResizeMove);
    document.addEventListener("mouseup", onResizeEnd);
  }

  function startDrag(e) {
    if (e.target.closest("button")) return;

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
    if (isPinned) return;
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
    isPinned = false;
    currentOverlayMode = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", onResizeEnd);
  }

  function renderOverlay(rect, overlayState) {
    if (!overlayHost) {
      overlayHost = document.createElement("div");
      overlayHost.style.cssText =
        "position:fixed;z-index:2147483647;pointer-events:none;";
      overlayHost.attachShadow({ mode: "open" });
      document.body.appendChild(overlayHost);
    }

    const shadow = overlayHost.shadowRoot;
    const { mode } = overlayState;
    currentOverlayMode = mode;

    const style = `
      *, *::before, *::after { box-sizing: border-box; }
      :host {
        font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #111;
      }
      .popover {
        background: #fff;
        border: 1.5px solid #111;
        border-radius: 8px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.10);
        display: flex;
        flex-direction: column;
        min-width: 260px;
        max-width: 480px;
        width: max-content;
        position: relative;
        pointer-events: auto;
        overflow: hidden;
        min-height: 80px;
      }
      .popover .body { flex: 1 1 auto; max-height: none; }
      .popover .history-list { flex: 1 1 auto; max-height: none; }
      .caret {
        position: absolute;
        width: 12px;
        height: 12px;
        background: #fff;
        border-left: 1.5px solid #111;
        border-top: 1.5px solid #111;
        z-index: 1;
      }
      .caret-top  { top: -7px; transform: rotate(45deg); }
      .caret-bottom { bottom: -7px; transform: rotate(225deg); }
      .toolbar {
        padding: 8px 12px;
        border-bottom: 1px solid #f0f0f0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: grab;
        user-select: none;
      }
      .toolbar:active { cursor: grabbing; }
      .toolbar-left { display: flex; align-items: center; gap: 6px; }
      .toolbar-right { display: flex; align-items: center; gap: 10px; }
      .lang-label { font-size: 12px; color: #888; }
      .token-label { font-size: 11px; color: #111; font-weight: 600; }
      .cache-badge {
        font-size: 10px; font-weight: 500;
        color: #166534; background: #f0fdf4;
        border: 1px solid #bbf7d0;
        border-radius: 4px; padding: 1px 6px;
      }
      .icon-btn {
        cursor: pointer; background: transparent; border: none;
        padding: 0; color: #bbb; font-size: 14px;
        display: flex; align-items: center; line-height: 1;
        transition: color 0.15s;
      }
      .icon-btn:hover { color: #111; }
      .icon-btn.active { color: #111; }
      .body {
        padding: 12px 14px;
        font-size: 15px; color: #111; line-height: 1.75;
        max-height: 220px; overflow-y: auto;
        white-space: pre-wrap; word-break: break-word;
      }
      .footer {
        padding: 8px 12px 10px;
        border-top: 1px solid #f0f0f0;
        display: flex; justify-content: space-between; align-items: center;
      }
      .footer-meta { font-size: 11px; color: #ccc; }
      .copy-btn {
        background: #111; color: #fff; border: none;
        border-radius: 5px; padding: 5px 14px;
        font-size: 12px; font-weight: 600; cursor: pointer;
        font-family: inherit; transition: opacity 0.15s;
      }
      .copy-btn:hover { opacity: 0.8; }
      .loading-row {
        padding: 14px; display: flex; align-items: center; gap: 8px;
        color: #888; font-size: 13px;
        pointer-events: auto; cursor: grab;
      }
      .loading-row:active { cursor: grabbing; }
      .spinner {
        width: 14px; height: 14px;
        border: 1.5px solid #111; border-top-color: transparent;
        border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .warning-body { padding: 14px 16px 10px; }
      .warning-title { font-size: 14px; font-weight: 700; margin-bottom: 5px; }
      .warning-sub { font-size: 13px; color: #666; line-height: 1.6; }
      .warning-actions { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 7px; }
      .btn-primary {
        background: #111; color: #fff; border: none; border-radius: 6px;
        padding: 10px 14px; cursor: pointer;
        display: flex; justify-content: space-between; align-items: center;
        font-size: 13px; font-family: inherit; font-weight: 500; transition: opacity 0.15s;
      }
      .btn-primary:hover { opacity: 0.85; }
      .btn-primary .token-hint { font-size: 11px; opacity: 0.65; }
      .btn-row { display: flex; gap: 7px; }
      .btn-secondary {
        flex: 1; border: 1.5px solid #ddd; background: #fff; border-radius: 6px;
        padding: 8px; text-align: center; cursor: pointer;
        font-size: 13px; font-family: inherit; color: #333; font-weight: 500;
        transition: border-color 0.15s;
      }
      .btn-secondary:hover { border-color: #aaa; }
      .btn-cancel {
        border: 1.5px solid #eee; background: #fff; border-radius: 6px;
        padding: 8px 14px; cursor: pointer;
        font-size: 13px; font-family: inherit; color: #bbb;
      }
      .btn-cancel:hover { border-color: #ddd; color: #888; }
      .resize-handle {
        position: absolute; bottom: 0; right: 0;
        width: 14px; height: 14px; cursor: se-resize;
        background: linear-gradient(135deg, transparent 50%, #ccc 50%, #ccc 62%, transparent 62%, transparent 75%, #ccc 75%);
        border-bottom-right-radius: 7px;
        pointer-events: auto;
      }
      .history-header {
        padding: 10px 14px; border-bottom: 1px solid #f0f0f0;
        display: flex; justify-content: space-between; align-items: center;
      }
      .history-title { font-size: 13px; font-weight: 700; }
      .history-list { max-height: 200px; overflow-y: auto; }
      .history-item {
        padding: 10px 14px; border-bottom: 1px solid #f8f8f8; cursor: pointer;
      }
      .history-item:last-child { border-bottom: none; }
      .history-item:hover { background: #fafafa; }
      .history-meta { font-size: 11px; color: #bbb; margin-bottom: 4px; }
      .history-cols {
        display: grid; grid-template-columns: 1fr 1px 1fr; gap: 0 8px;
        font-size: 12px; line-height: 1.45;
      }
      .history-divider { background: #e8e8e8; }
      .history-original {
        color: #999; overflow: hidden; display: -webkit-box;
        -webkit-line-clamp: 3; -webkit-box-orient: vertical;
      }
      .history-translated {
        color: #111; overflow: hidden; display: -webkit-box;
        -webkit-line-clamp: 3; -webkit-box-orient: vertical;
      }
      .history-footer {
        padding: 8px 14px; border-top: 1px solid #f0f0f0;
        display: flex; justify-content: space-between; align-items: center;
      }
      .history-total { font-size: 11px; color: #bbb; }
      .link-btn {
        background: none; border: none; font-size: 11px; color: #bbb;
        cursor: pointer; font-family: inherit; padding: 0;
      }
      .link-btn:hover { color: #555; }
      .error-body { padding: 12px 14px; color: #c00; font-size: 13px; }
      .detail-section { padding: 8px 14px; border-bottom: 1px solid #f0f0f0; }
      .detail-section:last-of-type { border-bottom: none; }
      .detail-label { font-size: 10px; color: #bbb; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
      .detail-text { font-size: 13px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; overflow-y: auto; max-height: 150px; }
      .detail-original { color: #999; }
      .detail-translated { color: #111; }
      .back-icon { font-size: 16px; line-height: 1; }
    `;

    const closeIcon = `<svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor"><path d="M10.5 1.5L9 0 5.5 3.5 2 0 .5 1.5 4 5 .5 8.5 2 10l3.5-3.5L9 10l1.5-1.5L7 5z"/></svg>`;
    const pinIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z"/></svg>`;
    const histIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-2.05-4.95L15 9h5V4l-1.76 1.76A8.97 8.97 0 0 0 13 3zm-1 5v5l4.28 2.54.72-1.21L13 12.5V8z"/></svg>`;

    let content = "";

    if (mode === "loading") {
      content = `
        <div class="popover">
          <div class="caret caret-top"></div>
          <div class="loading-row">
            <span class="spinner"></span><span>翻译中…</span>
          </div>
        </div>`;
    } else if (mode === "warning") {
      const { text } = overlayState;
      const fullTokens = estimateTokens(text);
      const truncTokens = estimateTokens(text.slice(0, LONG_TEXT_THRESHOLD));
      content = `
        <div class="popover">
          <div class="caret caret-top"></div>
          <div class="warning-body">
            <div class="warning-title">选中内容较长</div>
            <div class="warning-sub">共 <b>${text.length} 字</b>，约 <b>${fullTokens} tokens</b></div>
          </div>
          <div class="warning-actions">
            <button class="btn-primary" id="warn-truncate">
              <span>只翻译前 ${LONG_TEXT_THRESHOLD} 字</span>
              <span class="token-hint">~${truncTokens} tokens</span>
            </button>
            <div class="btn-row">
              <button class="btn-secondary" id="warn-full">全文翻译 <span style="font-size:11px;color:#aaa;font-weight:400">${fullTokens}t</span></button>
              <button class="btn-cancel" id="warn-cancel">取消</button>
            </div>
          </div>
        </div>`;
    } else if (mode === "result" && overlayState.result) {
      const {
        translatedText,
        targetLanguage,
        tokenEstimate,
        fromCache,
        streaming,
      } = overlayState.result;
      const tokenLabel = fromCache
        ? `<span class="cache-badge">缓存 · 0 tokens</span>`
        : streaming
          ? `<span class="token-label" style="color:#ccc">…</span>`
          : `<span class="token-label">${tokenEstimate} tokens</span>`;
      const savedLabel = fromCache
        ? `节省 ~${estimateTokens(translatedText)}t`
        : "";
      content = `
        <div class="popover">
          <div class="caret caret-top"></div>
          <div class="toolbar">
            <div class="toolbar-left">
              <span class="lang-label">${escapeHtml(targetLanguage || "")}</span>
              ${tokenLabel}
            </div>
            <div class="toolbar-right">
              <button class="icon-btn${isPinned ? " active" : ""}" id="pin-btn" title="固定">${pinIcon}</button>
              <button class="icon-btn" id="hist-btn" title="历史">${histIcon}</button>
              <button class="icon-btn" id="close-btn" title="关闭">${closeIcon}</button>
            </div>
          </div>
          <div class="body">${escapeHtml(translatedText)}</div>
          <div class="footer">
            <span class="footer-meta">${escapeHtml(savedLabel)}</span>
            <button class="copy-btn" id="copy-btn">Copy</button>
          </div>
        </div>`;
    } else if (mode === "history") {
      const totalTokens = sessionHistory.reduce(
        (s, h) => s + h.tokenEstimate,
        0,
      );
      const items = sessionHistory.length
        ? sessionHistory
            .map((h, i) => {
              const ago = Math.round((Date.now() - h.timestamp) / 60000);
              const agoStr = ago < 1 ? "刚刚" : `${ago} 分钟前`;
              const meta = h.fromCache
                ? `${agoStr} · 缓存`
                : `${agoStr} · ${h.tokenEstimate} tokens`;
              return `<div class="history-item" data-index="${i}">
              <div class="history-meta">${meta}</div>
              <div class="history-cols">
                <div class="history-original">${escapeHtml(h.originalText)}</div>
                <div class="history-divider"></div>
                <div class="history-translated">${escapeHtml(h.translatedText)}</div>
              </div>
            </div>`;
            })
            .join("")
        : `<div style="padding:16px 14px;font-size:13px;color:#bbb">暂无历史记录</div>`;
      content = `
        <div class="popover">
          <div class="history-header">
            <span class="history-title">本页历史 (${sessionHistory.length})</span>
            <button class="icon-btn" id="close-btn">${closeIcon}</button>
          </div>
          <div class="history-list">${items}</div>
          <div class="history-footer">
            <span class="history-total">本页共消耗 ${totalTokens} tokens</span>
            <button class="link-btn" id="clear-hist">清除</button>
          </div>
        </div>`;
    } else if (mode === "historyDetail") {
      const { entry } = overlayState;
      const metaStr = entry.fromCache
        ? "缓存 · 0 tokens"
        : `${entry.tokenEstimate} tokens`;
      content = `
        <div class="popover">
          <div class="toolbar">
            <div class="toolbar-left">
              <button class="icon-btn" id="back-btn" title="返回历史"><span class="back-icon">←</span></button>
              <span class="lang-label">历史详情</span>
            </div>
            <div class="toolbar-right">
              <button class="icon-btn" id="close-btn" title="关闭">${closeIcon}</button>
            </div>
          </div>
          <div class="detail-section">
            <div class="detail-label">原文</div>
            <div class="detail-text detail-original">${escapeHtml(entry.originalText)}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">译文</div>
            <div class="detail-text detail-translated">${escapeHtml(entry.translatedText)}</div>
          </div>
          <div class="footer">
            <span class="footer-meta">${metaStr}</span>
            <button class="copy-btn" id="copy-btn">Copy</button>
          </div>
        </div>`;
    } else if (mode === "error") {
      content = `
        <div class="popover">
          <div class="caret caret-top"></div>
          <div class="toolbar">
            <span style="font-size:12px;color:#c00">翻译失败</span>
            <button class="icon-btn" id="close-btn">${closeIcon}</button>
          </div>
          <div class="error-body">${escapeHtml(overlayState.message || "未知错误")}</div>
          <div class="footer">
            <span></span>
            <button class="copy-btn" id="retry-btn" style="background:#c00">重试</button>
          </div>
        </div>`;
    }

    shadow.innerHTML = `<style>${style}</style>${content}`;

    const popoverDiv = shadow.querySelector(".popover");
    const caretDiv = shadow.querySelector(".caret");
    if (!isManuallyPositioned) positionOverlay(popoverDiv, caretDiv, rect);
    else if (caretDiv) caretDiv.style.display = "none";

    if (popoverDiv) {
      const resizeHandle = document.createElement("div");
      resizeHandle.className = "resize-handle";
      popoverDiv.appendChild(resizeHandle);
      resizeHandle.addEventListener("mousedown", startResize);
    }

    const toolbar = shadow.querySelector(".toolbar");
    const loadingRow = shadow.querySelector(".loading-row");
    if (toolbar) toolbar.addEventListener("mousedown", startDrag);
    if (loadingRow) loadingRow.addEventListener("mousedown", startDrag);

    const closeBtn = shadow.getElementById("close-btn");
    if (closeBtn)
      closeBtn.addEventListener("click", () => {
        isPinned = false;
        removeOverlay();
      });

    const copyBtn = shadow.getElementById("copy-btn");
    if (copyBtn && overlayState.result) {
      copyBtn.addEventListener("click", () =>
        copyText(overlayState.result.translatedText),
      );
    }

    const pinBtn = shadow.getElementById("pin-btn");
    if (pinBtn) {
      pinBtn.addEventListener("click", () => {
        isPinned = !isPinned;
        renderOverlay(rect, overlayState);
      });
    }

    const histBtn = shadow.getElementById("hist-btn");
    if (histBtn) {
      histBtn.addEventListener("click", () =>
        renderOverlay(rect, { mode: "history" }),
      );
    }

    const retryBtn = shadow.getElementById("retry-btn");
    if (retryBtn && overlayState.retryText) {
      retryBtn.addEventListener("click", () =>
        requestTranslation(overlayState.retryText, rect),
      );
    }

    const warnTruncate = shadow.getElementById("warn-truncate");
    if (warnTruncate && overlayState.text) {
      warnTruncate.addEventListener("click", () => {
        const truncated = overlayState.text.slice(0, LONG_TEXT_THRESHOLD);
        lastText = truncated;
        requestTranslation(truncated, rect);
      });
    }

    const warnFull = shadow.getElementById("warn-full");
    if (warnFull && overlayState.text) {
      warnFull.addEventListener("click", () =>
        requestTranslation(overlayState.text, rect),
      );
    }

    const warnCancel = shadow.getElementById("warn-cancel");
    if (warnCancel) warnCancel.addEventListener("click", removeOverlay);

    const clearHist = shadow.getElementById("clear-hist");
    if (clearHist) {
      clearHist.addEventListener("click", () => {
        sessionHistory.length = 0;
        renderOverlay(rect, { mode: "history" });
      });
    }

    shadow.querySelectorAll(".history-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.index, 10);
        const entry = sessionHistory[idx];
        if (!entry) return;
        renderOverlay(rect, { mode: "historyDetail", entry });
      });
    });

    const backBtn = shadow.getElementById("back-btn");
    if (backBtn) {
      backBtn.addEventListener("click", () =>
        renderOverlay(rect, { mode: "history" }),
      );
    }

    const detailCopyBtn = shadow.getElementById("copy-btn");
    if (detailCopyBtn && mode === "historyDetail" && overlayState.entry) {
      detailCopyBtn.addEventListener("click", () =>
        copyText(overlayState.entry.translatedText),
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
