// ==UserScript==
// @name         HoverLens - CtrlCtrl Image Preview
// @namespace    https://github.com/TnZzZHlp/hoverlens
// @version      1.1.6
// @description  悬停图片后双击 Ctrl 打开全屏预览，支持滚轮缩放、拖拽、双击重置与快捷关闭。
// @match        *://*/*
// @connect      *
// @grant        GM_addValueChangeListener
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const INSTALL_GUARD_KEY = "__HOVERLENS_TM_INSTALLED__";
  const CONFIG = {
    debug: false,
doubleCtrlInterval: 360,
maxAncestorSearchDepth: 8,
descendantSearchDepth: 2,
    minScale: 0.2,
    maxScale: 8,
    zoomStep: 0.18,
    overlayZIndex: 2147483646,
    animationDurationMs: 140,
    styleId: "hl-tm-style",
    overlayId: "hl-tm-overlay",
    aiPanelId: "hl-tm-ai-panel",
    aiPanelToggleId: "hl-tm-ai-toggle",
    aiPanelStyleId: "hl-tm-ai-style",
    aiConfigStorageKey: "__HOVERLENS_AI_CONFIG__",
    defaultAiConfig: {
      enabled: false,
      apiFormat: "google-genai",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "",
      model: "gemini-3-flash-preview",
      temperature: 0.7,
      systemPrompt: "你是一个专业、可靠的 AI 助手。",
      enableGoogleSearchGrounding: true
    },

imageUrlResolverHook: null,
    editorBlockSelectors: [
      ".monaco-editor",
      ".monaco-workbench",
      ".CodeMirror",
      ".cm-editor",
      ".ace_editor",
      ".ql-editor",
      ".ProseMirror",
      '[data-testid*="editor"]',
      '[class*="monaco-editor"]',
      '[class*="CodeMirror"]',
      '[class*="cm-editor"]'
    ]
  };
  var _GM_addValueChangeListener = (() => typeof GM_addValueChangeListener != "undefined" ? GM_addValueChangeListener : void 0)();
  var _GM_getValue = (() => typeof GM_getValue != "undefined" ? GM_getValue : void 0)();
  var _GM_setValue = (() => typeof GM_setValue != "undefined" ? GM_setValue : void 0)();
  var _GM_xmlhttpRequest = (() => typeof GM_xmlhttpRequest != "undefined" ? GM_xmlhttpRequest : void 0)();
  const state = {
    hoveredElement: null,
    pointerX: Number.NaN,
    pointerY: Number.NaN,
    isOpen: false,
    scale: 1,
    translateX: 0,
    translateY: 0,
    dragging: false,
    activeDragPointerId: null,
    dragStartX: 0,
    dragStartY: 0,
    startTranslateX: 0,
    startTranslateY: 0,
    activeImageUrl: "",
    lastCtrlKeydownAt: 0,
    globalEventsBound: false,
    aiPanelOpen: false,
    aiConfig: { ...CONFIG.defaultAiConfig }
  };
  const refs = {
    overlay: null,
    image: null,
    aiPanel: null,
    aiPanelToggle: null
  };
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function isElement(node) {
    return node instanceof Element;
  }
  function safeGetComputedStyle(el) {
    try {
      return window.getComputedStyle(el);
    } catch {
      return null;
    }
  }
  function resolveUrl(rawUrl) {
    if (typeof rawUrl !== "string") return null;
    const cleaned = rawUrl.trim().replace(/^['"]|['"]$/g, "");
    if (!cleaned) return null;
    if (/^javascript:/i.test(cleaned)) return null;
    if (/^data:image\//i.test(cleaned) || /^blob:/i.test(cleaned)) {
      return cleaned;
    }
    try {
      return new URL(cleaned, window.location.href).href;
    } catch {
      return null;
    }
  }
  function normalizeImageUrl(rawUrl, context) {
    const resolved = resolveUrl(rawUrl);
    if (!resolved) return null;
    return resolved;
  }
  function pickBestFromSrcset(srcsetValue) {
    if (typeof srcsetValue !== "string" || !srcsetValue.trim()) return null;
    const entries = srcsetValue.split(",").map((item) => item.trim()).filter(Boolean);
    let best = null;
    for (const entry of entries) {
      const tokens = entry.split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      let descriptor = "";
      let rawUrl = entry;
      const last = tokens[tokens.length - 1];
      if (/^\d+(\.\d+)?[wx]$/i.test(last)) {
        descriptor = last.toLowerCase();
        rawUrl = tokens.slice(0, -1).join(" ");
      } else {
        rawUrl = tokens.join(" ");
      }
      const url = resolveUrl(rawUrl);
      if (!url) continue;
      let score = 1;
      if (descriptor.endsWith("w")) {
        score = Number.parseFloat(descriptor) || 1;
      } else if (descriptor.endsWith("x")) {
        score = (Number.parseFloat(descriptor) || 1) * 1e3;
      }
      if (!best || score > best.score) {
        best = { url, score };
      }
    }
    return best ? best.url : null;
  }
  const TEMPERATURE_MIN = 0;
  const TEMPERATURE_MAX = 2;
  const SYSTEM_PROMPT_MAX_LENGTH = 4e3;
  const MAX_SAFE_Z_INDEX = 2147483647;
  const AI_PANEL_Z_INDEX = Math.min(CONFIG.overlayZIndex + 1, MAX_SAFE_Z_INDEX);
  const AI_TOGGLE_Z_INDEX = Math.min(CONFIG.overlayZIndex + 2, MAX_SAFE_Z_INDEX);
  const AI_TOGGLE_VISIBLE_CLASS = "is-visible";
  function cloneDefaultAiConfig() {
    return { ...CONFIG.defaultAiConfig };
  }
  function sanitizeText(value, fallback, allowEmpty = false) {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    if (allowEmpty) return trimmed;
    return trimmed || fallback;
  }
  function normalizeApiFormat(value) {
    if (value === "openai-compatible" || value === "google-genai") {
      return value;
    }
    return CONFIG.defaultAiConfig.apiFormat;
  }
  function normalizeAiConfig(raw) {
    const next = cloneDefaultAiConfig();
    if (!raw || typeof raw !== "object") return next;
    const payload = raw;
    if (typeof payload.enabled === "boolean") {
      next.enabled = payload.enabled;
    }
    next.apiFormat = normalizeApiFormat(payload.apiFormat);
    next.provider = sanitizeText(payload.provider, next.provider);
    next.baseUrl = sanitizeText(payload.baseUrl, next.baseUrl);
    next.apiKey = sanitizeText(payload.apiKey, "", true);
    next.model = sanitizeText(payload.model, next.model);
    next.systemPrompt = sanitizeText(payload.systemPrompt, next.systemPrompt, true);
    if (typeof payload.enableGoogleSearchGrounding === "boolean") {
      next.enableGoogleSearchGrounding = payload.enableGoogleSearchGrounding;
    }
    if (typeof payload.temperature === "number" && Number.isFinite(payload.temperature)) {
      next.temperature = clamp(payload.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX);
    }
    return next;
  }
  function isSameAiConfig(left, right) {
    return left.enabled === right.enabled && left.apiFormat === right.apiFormat && left.provider === right.provider && left.baseUrl === right.baseUrl && left.apiKey === right.apiKey && left.model === right.model && Math.abs(left.temperature - right.temperature) <= Number.EPSILON && left.systemPrompt === right.systemPrompt && left.enableGoogleSearchGrounding === right.enableGoogleSearchGrounding;
  }
  function isHttpUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  function clearControlValidation(control) {
    control.classList.remove("is-invalid");
    control.removeAttribute("aria-invalid");
  }
  function markControlInvalid(control) {
    control.classList.add("is-invalid");
    control.setAttribute("aria-invalid", "true");
  }
  function clearValidationState(panel) {
    const controls = panel.querySelectorAll(".hl-ai-control");
    controls.forEach(clearControlValidation);
  }
  function validateDraftConfig(panel, config2) {
    const elements = getFormElements(panel);
    if (!elements) return "表单元素异常，暂时无法保存。";
    clearValidationState(panel);
    if (config2.baseUrl && !isHttpUrl(config2.baseUrl)) {
      markControlInvalid(elements.baseUrl);
      return "Base URL 必须是合法的 http(s) 地址。";
    }
    if (!config2.enabled) {
      return null;
    }
    if (!config2.apiKey) {
      markControlInvalid(elements.apiKey);
      return "已启用 AI，请先填写 API Key。";
    }
    if (config2.apiFormat === "openai-compatible") {
      markControlInvalid(elements.apiFormat);
      return "openai-compatible 尚未接入请求通道，请改用 Google GenAI。";
    }
    return null;
  }
  function decodePersistedAiConfig(raw) {
    if (typeof raw === "string") {
      try {
        return normalizeAiConfig(JSON.parse(raw));
      } catch {
        return cloneDefaultAiConfig();
      }
    }
    return normalizeAiConfig(raw);
  }
  function loadAiConfigFromLocalStorage() {
    try {
      const raw = window.localStorage.getItem(CONFIG.aiConfigStorageKey);
      if (!raw) return cloneDefaultAiConfig();
      const parsed = JSON.parse(raw);
      return normalizeAiConfig(parsed);
    } catch (error2) {
      return cloneDefaultAiConfig();
    }
  }
  function saveAiConfigToLocalStorage(config2) {
    try {
      window.localStorage.setItem(CONFIG.aiConfigStorageKey, JSON.stringify(config2));
      return true;
    } catch (error2) {
      return false;
    }
  }
  function loadAiConfigFromStorage() {
    if (typeof _GM_getValue === "function") {
      try {
        const gmRaw = _GM_getValue(CONFIG.aiConfigStorageKey);
        if (typeof gmRaw !== "undefined") {
          return decodePersistedAiConfig(gmRaw);
        }
        const legacyConfig = loadAiConfigFromLocalStorage();
        if (typeof _GM_setValue === "function") {
          _GM_setValue(CONFIG.aiConfigStorageKey, legacyConfig);
        }
        return legacyConfig;
      } catch (error2) {
      }
    }
    return loadAiConfigFromLocalStorage();
  }
  function saveAiConfigToStorage(config2) {
    if (typeof _GM_setValue === "function") {
      try {
        _GM_setValue(CONFIG.aiConfigStorageKey, config2);
        return true;
      } catch (error2) {
      }
    }
    return saveAiConfigToLocalStorage(config2);
  }
  function ensureAiPanelStyle() {
    if (document.getElementById(CONFIG.aiPanelStyleId)) return;
    const style = document.createElement("style");
    style.id = CONFIG.aiPanelStyleId;
    style.textContent = `
#${CONFIG.aiPanelId} {
  position: fixed;
  inset: 0;
  z-index: ${AI_PANEL_Z_INDEX};
  pointer-events: none;
  visibility: hidden;
}

#${CONFIG.aiPanelId}.is-open {
  pointer-events: auto;
  visibility: visible;
}

#${CONFIG.aiPanelId} .hl-ai-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(9, 12, 18, 0.46);
  opacity: 0;
  transition: opacity ${CONFIG.animationDurationMs}ms ease;
}

#${CONFIG.aiPanelId}.is-open .hl-ai-backdrop {
  opacity: 1;
}

#${CONFIG.aiPanelId} .hl-ai-drawer {
  position: absolute;
  top: 14px;
  right: 14px;
  bottom: 14px;
  width: min(460px, calc(100vw - 28px));
  border-radius: 16px;
  border: 1px solid rgba(192, 203, 230, 0.24);
  background: rgba(18, 24, 34, 0.97);
  color: rgba(236, 241, 249, 0.96);
  box-shadow: 0 22px 56px rgba(0, 0, 0, 0.42);
  display: flex;
  flex-direction: column;
  transform: translate3d(14px, 0, 0);
  opacity: 0;
  font-family:
    "Segoe UI",
    "PingFang SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    sans-serif;
  line-height: 1.45;
  transition: transform ${CONFIG.animationDurationMs}ms ease, opacity ${CONFIG.animationDurationMs}ms ease;
}

#${CONFIG.aiPanelId}.is-open .hl-ai-drawer {
  transform: translate3d(0, 0, 0);
  opacity: 1;
}

#${CONFIG.aiPanelId} .hl-ai-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 10px;
  border-bottom: 1px solid rgba(192, 203, 230, 0.18);
}

#${CONFIG.aiPanelId} .hl-ai-title-wrap {
  display: grid;
  gap: 2px;
}

#${CONFIG.aiPanelId} .hl-ai-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}

#${CONFIG.aiPanelId} .hl-ai-subtitle {
  margin: 0;
  font-size: 12px;
  color: rgba(192, 205, 230, 0.78);
}

#${CONFIG.aiPanelId} .hl-ai-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid rgba(157, 175, 213, 0.28);
  border-radius: 8px;
  background: rgba(123, 149, 204, 0.18);
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

#${CONFIG.aiPanelId} .hl-ai-close:hover {
  background: rgba(136, 168, 234, 0.24);
}

#${CONFIG.aiPanelId} .hl-ai-close:focus-visible {
  outline: none;
  border-color: rgba(134, 178, 255, 0.82);
  box-shadow: 0 0 0 3px rgba(102, 158, 255, 0.24);
}

#${CONFIG.aiPanelId} .hl-ai-form {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
  padding: 14px 18px 18px;
  overflow: auto;
}

#${CONFIG.aiPanelId} .hl-ai-shortcut {
  margin: 0;
  font-size: 12px;
  color: rgba(191, 208, 238, 0.82);
}

#${CONFIG.aiPanelId} .hl-ai-field {
  display: grid;
  gap: 6px;
  min-width: 0;
}

#${CONFIG.aiPanelId} .hl-ai-field-label {
  font-size: 12px;
  font-weight: 600;
  color: rgba(202, 214, 236, 0.9);
}

#${CONFIG.aiPanelId} .hl-ai-field-hint {
  font-size: 11px;
  color: rgba(182, 198, 226, 0.74);
  overflow-wrap: break-word;
}

#${CONFIG.aiPanelId} .hl-ai-note {
  margin: 0;
  min-height: 16px;
  font-size: 11px;
  color: rgba(199, 215, 239, 0.7);
}

#${CONFIG.aiPanelId} .hl-ai-note.is-warning {
  color: rgba(255, 198, 133, 0.96);
}

#${CONFIG.aiPanelId} input[type="text"],
#${CONFIG.aiPanelId} input[type="password"],
#${CONFIG.aiPanelId} select,
#${CONFIG.aiPanelId} textarea,
#${CONFIG.aiPanelId} input[type="range"] {
  width: 100%;
  box-sizing: border-box;
}

#${CONFIG.aiPanelId} input[type="text"],
#${CONFIG.aiPanelId} input[type="password"],
#${CONFIG.aiPanelId} select,
#${CONFIG.aiPanelId} textarea {
  border: 1px solid rgba(157, 175, 213, 0.32);
  border-radius: 10px;
  background: rgba(11, 15, 22, 0.78);
  color: inherit;
  padding: 9px 11px;
  font-size: 13px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

#${CONFIG.aiPanelId} .hl-ai-control:focus-visible {
  outline: none;
  border-color: rgba(132, 178, 255, 0.85);
  box-shadow: 0 0 0 3px rgba(84, 143, 255, 0.22);
}

#${CONFIG.aiPanelId} .hl-ai-control.is-invalid {
  border-color: rgba(255, 153, 153, 0.94);
  box-shadow: 0 0 0 3px rgba(255, 125, 125, 0.18);
}

#${CONFIG.aiPanelId} input[type="range"] {
  accent-color: rgba(125, 170, 255, 0.95);
}

#${CONFIG.aiPanelId} textarea {
  min-height: 92px;
  resize: vertical;
}

#${CONFIG.aiPanelId} .hl-ai-input-with-action {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

#${CONFIG.aiPanelId} .hl-ai-input-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 52px;
  border: 1px solid rgba(157, 175, 213, 0.32);
  border-radius: 8px;
  background: rgba(58, 75, 113, 0.44);
  color: rgba(220, 230, 248, 0.94);
  font-size: 12px;
  line-height: 1;
  text-align: center;
  white-space: nowrap;
  padding: 8px 10px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

#${CONFIG.aiPanelId} .hl-ai-input-action:hover {
  background: rgba(74, 96, 144, 0.52);
}

#${CONFIG.aiPanelId} .hl-ai-input-action:focus-visible {
  outline: none;
  border-color: rgba(134, 178, 255, 0.82);
  box-shadow: 0 0 0 3px rgba(102, 158, 255, 0.24);
}

#${CONFIG.aiPanelId} .hl-ai-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

#${CONFIG.aiPanelId} .hl-ai-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

#${CONFIG.aiPanelId} .hl-ai-switch input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: rgba(123, 171, 255, 0.94);
}

#${CONFIG.aiPanelId} [data-role="google-grounding-row"].is-disabled {
  opacity: 0.58;
}

#${CONFIG.aiPanelId} .hl-ai-temp-value {
  font-size: 12px;
  color: rgba(187, 209, 255, 0.88);
  min-width: 36px;
  text-align: right;
}

#${CONFIG.aiPanelId} .hl-ai-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid rgba(169, 187, 220, 0.18);
}

#${CONFIG.aiPanelId} .hl-ai-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 10px;
  min-height: 34px;
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.2;
  text-align: center;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, transform 80ms ease;
}

#${CONFIG.aiPanelId} .hl-ai-btn-ghost {
  background: rgba(122, 146, 191, 0.2);
  color: rgba(224, 233, 248, 0.94);
  border-color: rgba(157, 175, 213, 0.26);
}

#${CONFIG.aiPanelId} .hl-ai-btn-primary {
  background: rgba(111, 161, 255, 0.88);
  color: rgba(10, 14, 22, 0.98);
  border-color: rgba(115, 167, 255, 0.4);
}

#${CONFIG.aiPanelId} .hl-ai-btn:hover {
  transform: translateY(-0.5px);
}

#${CONFIG.aiPanelId} .hl-ai-btn:active {
  transform: translateY(0);
}

#${CONFIG.aiPanelId} .hl-ai-btn:focus-visible {
  outline: none;
  border-color: rgba(134, 178, 255, 0.82);
  box-shadow: 0 0 0 3px rgba(102, 158, 255, 0.24);
}

#${CONFIG.aiPanelId} .hl-ai-btn:disabled {
  opacity: 0.52;
  cursor: not-allowed;
  transform: none;
}

#${CONFIG.aiPanelId} .hl-ai-status {
  min-height: 18px;
  margin: 0;
  font-size: 12px;
  color: rgba(163, 218, 188, 0.94);
}

#${CONFIG.aiPanelId} .hl-ai-status.is-error {
  color: rgba(255, 173, 173, 0.96);
}

#${CONFIG.aiPanelToggleId} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: ${AI_TOGGLE_Z_INDEX};
  display: none !important;
  border: none;
  border-radius: 999px;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 700;
  background: rgba(42, 58, 92, 0.9);
  color: rgba(232, 239, 250, 0.97);
  box-shadow: 0 10px 30px rgba(7, 10, 16, 0.34);
  cursor: pointer;
}

#${CONFIG.aiPanelToggleId}.${AI_TOGGLE_VISIBLE_CLASS} {
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
}

#${CONFIG.aiPanelToggleId}:hover {
  background: rgba(59, 82, 131, 0.94);
}

#${CONFIG.aiPanelToggleId}:active {
  transform: translateY(1px);
}

@media (max-width: 640px) {
  #${CONFIG.aiPanelId} .hl-ai-drawer {
    inset: 0;
    width: 100%;
    border-radius: 0;
    border-left: none;
    border-right: none;
    border-bottom: none;
  }

  #${CONFIG.aiPanelId} .hl-ai-header,
  #${CONFIG.aiPanelId} .hl-ai-form {
    padding-left: 14px;
    padding-right: 14px;
  }

  #${CONFIG.aiPanelToggleId} {
    right: 12px;
    bottom: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  #${CONFIG.aiPanelId} .hl-ai-backdrop,
  #${CONFIG.aiPanelId} .hl-ai-drawer,
  #${CONFIG.aiPanelToggleId} {
    transition: none !important;
  }
}
  `.trim();
    (document.head || document.documentElement).appendChild(style);
  }
  function createPanelElement() {
    const panel = document.createElement("div");
    panel.id = CONFIG.aiPanelId;
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = `
<div class="hl-ai-backdrop" data-action="close"></div>
<section class="hl-ai-drawer" role="dialog" aria-modal="true" aria-labelledby="hl-ai-title">
  <header class="hl-ai-header">
    <div class="hl-ai-title-wrap">
      <h2 id="hl-ai-title" class="hl-ai-title">AI 设置</h2>
      <p class="hl-ai-subtitle">调整模型与参数，保存后立即生效</p>
    </div>
    <button class="hl-ai-close" type="button" data-action="close" aria-label="关闭面板">×</button>
  </header>
  <form class="hl-ai-form" novalidate>
    <p class="hl-ai-shortcut">快捷键：Ctrl + Shift + A（仅在图片预览开启时可用）</p>

    <label class="hl-ai-row hl-ai-switch">
      <span>启用 AI 能力</span>
      <input name="enabled" type="checkbox" />
    </label>

    <label class="hl-ai-field">
      <span class="hl-ai-field-label">API 格式</span>
      <select class="hl-ai-control" name="apiFormat">
        <option value="google-genai">Google GenAI</option>
        <option value="openai-compatible">OpenAI Compatible</option>
      </select>
      <span class="hl-ai-field-hint">决定请求协议以及可用能力。</span>
      <p class="hl-ai-note" data-role="api-format-note" aria-live="polite"></p>
    </label>

    <label class="hl-ai-field">
      <span class="hl-ai-field-label">Provider</span>
      <input class="hl-ai-control" name="provider" type="text" autocomplete="off" placeholder="google" />
      <span class="hl-ai-field-hint">用于标识供应商（例如 google / openai）。</span>
    </label>

    <label class="hl-ai-field">
      <span class="hl-ai-field-label">Base URL</span>
      <input
        class="hl-ai-control"
        name="baseUrl"
        type="text"
        inputmode="url"
        autocomplete="off"
        placeholder="https://generativelanguage.googleapis.com"
      />
      <span class="hl-ai-field-hint">必须为 http(s) 地址；留空会回退默认值。</span>
    </label>

    <label class="hl-ai-field">
      <span class="hl-ai-field-label">API Key</span>
      <div class="hl-ai-input-with-action">
        <input class="hl-ai-control" name="apiKey" type="password" autocomplete="off" placeholder="请输入 API Key" />
        <button
          class="hl-ai-input-action"
          type="button"
          data-action="toggle-api-key-visibility"
          data-role="api-key-toggle"
          aria-pressed="false"
        >显示密钥</button>
      </div>
      <span class="hl-ai-field-hint">优先保存在脚本存储（GM API），仅在不可用时回退 LocalStorage。</span>
    </label>

    <label class="hl-ai-field">
      <span class="hl-ai-field-label">Model</span>
      <input class="hl-ai-control" name="model" type="text" autocomplete="off" placeholder="gemini-3-flash-preview" />
    </label>

    <label class="hl-ai-field">
      <span class="hl-ai-row">
        <span class="hl-ai-field-label">Temperature（采样温度）</span>
        <span class="hl-ai-temp-value" data-role="temperature-value">0.7</span>
      </span>
      <input name="temperature" type="range" min="0" max="2" step="0.1" />
      <span class="hl-ai-field-hint">值越高越发散，值越低越稳定。推荐 0.2 ~ 1.0。</span>
    </label>

    <label class="hl-ai-field">
      <span class="hl-ai-field-label">System Prompt（系统提示词）</span>
      <textarea
        class="hl-ai-control"
        name="systemPrompt"
        spellcheck="false"
        maxlength="${SYSTEM_PROMPT_MAX_LENGTH}"
        placeholder="你是一个专业、可靠的 AI 助手。"
      ></textarea>
      <span class="hl-ai-field-hint">可留空，模型将使用默认系统行为。</span>
    </label>

    <div class="hl-ai-field" data-role="google-grounding-row">
      <label class="hl-ai-row hl-ai-switch">
        <span>启用 Google Search Grounding</span>
        <input name="enableGoogleSearchGrounding" type="checkbox" />
      </label>
      <span class="hl-ai-field-hint">仅 Google GenAI 格式支持该选项。</span>
    </div>

    <div class="hl-ai-actions">
      <button class="hl-ai-btn hl-ai-btn-ghost" type="button" data-action="reset">恢复默认值</button>
      <button class="hl-ai-btn hl-ai-btn-ghost" type="button" data-action="cancel">放弃修改</button>
      <button class="hl-ai-btn hl-ai-btn-primary" type="submit" data-role="save">保存设置</button>
    </div>

    <p class="hl-ai-status" data-role="status" aria-live="polite"></p>
  </form>
</section>
  `.trim();
    return panel;
  }
  function createToggleButtonElement() {
    const button = document.createElement("button");
    button.id = CONFIG.aiPanelToggleId;
    button.type = "button";
    button.hidden = true;
    button.textContent = "AI 设置";
    button.title = "打开 AI 配置（Ctrl + Shift + A）";
    button.setAttribute("aria-hidden", "true");
    button.setAttribute("aria-controls", CONFIG.aiPanelId);
    button.setAttribute("aria-expanded", "false");
    return button;
  }
  function getFormElements(panel) {
    const enabled = panel.querySelector('input[name="enabled"]');
    const apiFormat = panel.querySelector('select[name="apiFormat"]');
    const apiFormatNote = panel.querySelector('[data-role="api-format-note"]');
    const provider = panel.querySelector('input[name="provider"]');
    const baseUrl = panel.querySelector('input[name="baseUrl"]');
    const apiKey = panel.querySelector('input[name="apiKey"]');
    const apiKeyToggle = panel.querySelector('[data-role="api-key-toggle"]');
    const model = panel.querySelector('input[name="model"]');
    const temperature = panel.querySelector('input[name="temperature"]');
    const temperatureValue = panel.querySelector('[data-role="temperature-value"]');
    const systemPrompt = panel.querySelector('textarea[name="systemPrompt"]');
    const enableGoogleSearchGrounding = panel.querySelector(
      'input[name="enableGoogleSearchGrounding"]'
    );
    const saveButton = panel.querySelector('[data-role="save"]');
    const status = panel.querySelector('[data-role="status"]');
    if (!enabled || !apiFormat || !apiFormatNote || !provider || !baseUrl || !apiKey || !apiKeyToggle || !model || !temperature || !temperatureValue || !systemPrompt || !enableGoogleSearchGrounding || !saveButton || !status) {
      return null;
    }
    return {
      enabled,
      apiFormat,
      apiFormatNote,
      provider,
      baseUrl,
      apiKey,
      apiKeyToggle,
      model,
      temperature,
      temperatureValue,
      systemPrompt,
      enableGoogleSearchGrounding,
      saveButton,
      status
    };
  }
  function syncGoogleGroundingFieldState(panel) {
    const elements = getFormElements(panel);
    if (!elements) return;
    const wrapper = panel.querySelector('[data-role="google-grounding-row"]');
    if (!wrapper) return;
    const isGoogleGenAi = elements.apiFormat.value === "google-genai";
    if (!isGoogleGenAi) {
      elements.enableGoogleSearchGrounding.checked = false;
    }
    elements.enableGoogleSearchGrounding.disabled = !isGoogleGenAi;
    wrapper.classList.toggle("is-disabled", !isGoogleGenAi);
    wrapper.title = isGoogleGenAi ? "开启后会按 Google GenAI 的 tools 格式附带 googleSearch。" : "仅 Google GenAI 格式支持该选项。";
  }
  function syncApiFormatNotice(panel) {
    const elements = getFormElements(panel);
    if (!elements) return;
    const isOpenAiCompatible = elements.apiFormat.value === "openai-compatible";
    elements.apiFormatNote.textContent = isOpenAiCompatible ? "提示：openai-compatible 在当前版本尚未接入请求通道。" : "";
    elements.apiFormatNote.classList.toggle("is-warning", isOpenAiCompatible);
  }
  function setApiKeyVisibility(panel, visible) {
    const elements = getFormElements(panel);
    if (!elements) return;
    elements.apiKey.type = visible ? "text" : "password";
    elements.apiKeyToggle.textContent = visible ? "隐藏密钥" : "显示密钥";
    elements.apiKeyToggle.setAttribute("aria-pressed", visible ? "true" : "false");
    elements.apiKeyToggle.title = visible ? "隐藏密钥" : "显示密钥";
  }
  function syncSaveButtonState(panel) {
    const elements = getFormElements(panel);
    if (!elements) return;
    const draftConfig = readForm(panel);
    if (!draftConfig) {
      elements.saveButton.disabled = true;
      return;
    }
    elements.saveButton.disabled = isSameAiConfig(draftConfig, state.aiConfig);
  }
  function updateTemperatureLabel(elements) {
    const value = Number.parseFloat(elements.temperature.value);
    const safeValue = Number.isFinite(value) ? clamp(value, TEMPERATURE_MIN, TEMPERATURE_MAX) : 0;
    elements.temperatureValue.textContent = safeValue.toFixed(1);
  }
  function fillForm(panel, config2) {
    const elements = getFormElements(panel);
    if (!elements) return;
    elements.enabled.checked = config2.enabled;
    elements.apiFormat.value = config2.apiFormat;
    elements.provider.value = config2.provider;
    elements.baseUrl.value = config2.baseUrl;
    elements.apiKey.value = config2.apiKey;
    elements.model.value = config2.model;
    elements.temperature.value = String(clamp(config2.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX));
    elements.systemPrompt.value = config2.systemPrompt;
    elements.enableGoogleSearchGrounding.checked = config2.enableGoogleSearchGrounding;
    elements.status.textContent = "";
    elements.status.classList.remove("is-error");
    clearValidationState(panel);
    setApiKeyVisibility(panel, false);
    updateTemperatureLabel(elements);
    syncGoogleGroundingFieldState(panel);
    syncApiFormatNotice(panel);
    syncSaveButtonState(panel);
  }
  function readForm(panel) {
    const elements = getFormElements(panel);
    if (!elements) return null;
    const temperatureValue = Number.parseFloat(elements.temperature.value);
    const temperature = Number.isFinite(temperatureValue) ? clamp(temperatureValue, TEMPERATURE_MIN, TEMPERATURE_MAX) : CONFIG.defaultAiConfig.temperature;
    return {
      enabled: elements.enabled.checked,
      apiFormat: normalizeApiFormat(elements.apiFormat.value),
      provider: sanitizeText(elements.provider.value, CONFIG.defaultAiConfig.provider),
      baseUrl: sanitizeText(elements.baseUrl.value, CONFIG.defaultAiConfig.baseUrl),
      apiKey: sanitizeText(elements.apiKey.value, "", true),
      model: sanitizeText(elements.model.value, CONFIG.defaultAiConfig.model),
      temperature,
      systemPrompt: sanitizeText(elements.systemPrompt.value, "", true),
      enableGoogleSearchGrounding: elements.enableGoogleSearchGrounding.checked
    };
  }
  function setStatus(panel, message, isError = false) {
    const elements = getFormElements(panel);
    if (!elements) return;
    elements.status.textContent = message;
    elements.status.classList.toggle("is-error", isError);
  }
  function setPanelOpen(open) {
    const panel = refs.aiPanel;
    if (!panel) return;
    if (open && !state.isOpen) return;
    state.aiPanelOpen = open;
    panel.classList.toggle("is-open", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
    if (refs.aiPanelToggle) {
      refs.aiPanelToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (open) {
      fillForm(panel, state.aiConfig);
      const providerInput = panel.querySelector('input[name="provider"]');
      providerInput?.focus();
    }
  }
  function setToggleButtonVisible(visible) {
    const button = refs.aiPanelToggle;
    if (!button) return;
    button.classList.toggle(AI_TOGGLE_VISIBLE_CLASS, visible);
    button.hidden = !visible;
    button.style.display = visible ? "inline-flex" : "none";
    button.setAttribute("aria-hidden", visible ? "false" : "true");
    if (!visible) {
      button.setAttribute("aria-expanded", "false");
    }
  }
  function bindPanelEvents(panel) {
    if (panel.dataset.bound === "1") return;
    panel.dataset.bound = "1";
    panel.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const actionEl = target.closest("[data-action]");
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      if (action === "close" || action === "cancel") {
        event.preventDefault();
        closeAiPanel();
        return;
      }
      if (action === "reset") {
        event.preventDefault();
        fillForm(panel, cloneDefaultAiConfig());
        setStatus(panel, "已恢复默认值，点击“保存设置”后生效。");
        return;
      }
      if (action === "toggle-api-key-visibility") {
        event.preventDefault();
        const elements = getFormElements(panel);
        if (!elements) return;
        setApiKeyVisibility(panel, elements.apiKey.type === "password");
      }
    });
    const form = panel.querySelector("form");
    if (form instanceof HTMLFormElement) {
      const handleDraftChange = (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
          clearControlValidation(target);
        }
        if (target instanceof HTMLInputElement && target.name === "temperature") {
          const elements = getFormElements(panel);
          if (elements) {
            updateTemperatureLabel(elements);
          }
        }
        if (target instanceof HTMLSelectElement && target.name === "apiFormat") {
          syncGoogleGroundingFieldState(panel);
          syncApiFormatNotice(panel);
        }
        setStatus(panel, "");
        syncSaveButtonState(panel);
      };
      form.addEventListener("input", handleDraftChange);
      form.addEventListener("change", handleDraftChange);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const nextConfig = readForm(panel);
        if (!nextConfig) {
          setStatus(panel, "表单元素异常，暂时无法保存。", true);
          return;
        }
        const validationError = validateDraftConfig(panel, nextConfig);
        if (validationError) {
          setStatus(panel, validationError, true);
          return;
        }
        state.aiConfig = nextConfig;
        if (!saveAiConfigToStorage(nextConfig)) {
          setStatus(panel, "保存失败，请检查脚本存储权限。", true);
          return;
        }
        setStatus(panel, "AI 配置已保存并生效。", false);
        syncSaveButtonState(panel);
      });
    }
  }
  function bindToggleButtonEvents(button) {
    if (button.dataset.bound === "1") return;
    button.dataset.bound = "1";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      toggleAiPanel();
    });
  }
  function closeAiPanel() {
    setPanelOpen(false);
  }
  function toggleAiPanel(force) {
    if (!state.isOpen) {
      setPanelOpen(false);
      return;
    }
    const next = !state.aiPanelOpen;
    setPanelOpen(next);
  }
  function syncAiPanelAvailability(previewOpen) {
    const shouldShow = previewOpen && state.isOpen;
    if (!shouldShow && state.aiPanelOpen) {
      setPanelOpen(false);
    }
    setToggleButtonVisible(shouldShow);
  }
  function isAiPanelElement(target) {
    if (!target) return false;
    if (refs.aiPanel && refs.aiPanel.contains(target)) return true;
    if (refs.aiPanelToggle && refs.aiPanelToggle.contains(target)) return true;
    return false;
  }
  function bootstrapAiPanel() {
    ensureAiPanelStyle();
    state.aiConfig = loadAiConfigFromStorage();
    let panel = document.getElementById(CONFIG.aiPanelId);
    if (panel && !getFormElements(panel)) {
      panel.remove();
      panel = null;
    }
    if (!panel) {
      panel = createPanelElement();
    }
    if (!panel.isConnected) {
      (document.documentElement || document.body).appendChild(panel);
    }
    let toggleButton = document.getElementById(CONFIG.aiPanelToggleId);
    if (!(toggleButton instanceof HTMLButtonElement)) {
      toggleButton = createToggleButtonElement();
    }
    if (!toggleButton.isConnected) {
      (document.documentElement || document.body).appendChild(toggleButton);
    }
    refs.aiPanel = panel;
    refs.aiPanelToggle = toggleButton;
    setToggleButtonVisible(false);
    bindPanelEvents(panel);
    bindToggleButtonEvents(toggleButton);
    fillForm(panel, state.aiConfig);
    syncAiPanelAvailability(state.isOpen);
    if (typeof _GM_addValueChangeListener === "function") {
      _GM_addValueChangeListener(
        CONFIG.aiConfigStorageKey,
        (_key, _oldValue, newValue, remote) => {
          if (!remote) return;
          state.aiConfig = decodePersistedAiConfig(newValue);
          if (state.aiPanelOpen && refs.aiPanel) {
            fillForm(refs.aiPanel, state.aiConfig);
          }
        }
      );
    } else {
      window.addEventListener("storage", (event) => {
        if (event.key !== CONFIG.aiConfigStorageKey) return;
        state.aiConfig = decodePersistedAiConfig(event.newValue);
        if (state.aiPanelOpen && refs.aiPanel) {
          fillForm(refs.aiPanel, state.aiConfig);
        }
      });
    }
  }
  const NATIVE_EDITABLE_SELECTOR = [
    "input",
    "textarea",
    "select",
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]',
    '[role="searchbox"]'
  ].join(",");
  function isEditableTarget(target) {
    if (!isElement(target)) return false;
    if (target.matches(NATIVE_EDITABLE_SELECTOR) || target.closest(NATIVE_EDITABLE_SELECTOR)) {
      return true;
    }
    if (target instanceof HTMLElement && target.isContentEditable) {
      return true;
    }
    for (const selector of CONFIG.editorBlockSelectors) {
      try {
        if (target.closest(selector)) return true;
      } catch {
      }
    }
    return false;
  }
  function shouldIgnoreHotkey(event) {
    if (event.altKey || event.metaKey) return true;
    const activeEl = document.activeElement;
    if (isEditableTarget(event.target) || isEditableTarget(activeEl)) {
      return true;
    }
    return false;
  }
  function detectDoubleCtrl(event) {
    if (event.key !== "Control") return false;
    if (event.repeat) return false;
    const now = performance.now();
    const isDouble = state.lastCtrlKeydownAt > 0 && now - state.lastCtrlKeydownAt <= CONFIG.doubleCtrlInterval;
    state.lastCtrlKeydownAt = now;
    return isDouble;
  }
  function getBestImageUrlFromImg(img) {
    if (img.currentSrc) {
      const currentSrcUrl = normalizeImageUrl(img.currentSrc);
      if (currentSrcUrl) return currentSrcUrl;
    }
    const srcsetCandidates = [
      img.getAttribute("srcset"),
      img.getAttribute("data-srcset"),
      img.getAttribute("data-lazy-srcset")
    ];
    for (const srcset of srcsetCandidates) {
      const bestSrcsetUrl = pickBestFromSrcset(srcset);
      if (!bestSrcsetUrl) continue;
      const srcsetUrl = normalizeImageUrl(bestSrcsetUrl);
      if (srcsetUrl) return srcsetUrl;
    }
    const attrCandidates = [
      "data-fullsrc",
      "data-original",
      "data-origin",
      "data-zoom-src",
      "data-large-image",
      "data-src",
      "data-lazy-src",
      "src"
    ];
    for (const attr of attrCandidates) {
      const raw = img.getAttribute(attr);
      if (!raw) continue;
      const imageUrl = normalizeImageUrl(raw);
      if (imageUrl) return imageUrl;
    }
    return null;
  }
  function extractBackgroundImageUrl(el) {
    const style = safeGetComputedStyle(el);
    if (!style) return null;
    const bg = style.getPropertyValue("background-image") || style.backgroundImage;
    if (!bg || bg === "none") return null;
    const matches = [...bg.matchAll(/url\((['"]?)(.*?)\1\)/gi)];
    if (!matches.length) return null;
    for (const match2 of matches) {
      const rawUrl = match2[2];
      const bgUrl = normalizeImageUrl(rawUrl);
      if (bgUrl) return bgUrl;
    }
    return null;
  }
  function findDescendantImage(container) {
    try {
      const directChildImg = container.querySelector(":scope > img");
      if (directChildImg instanceof HTMLImageElement) return directChildImg;
    } catch {
    }
    const fallback = container.querySelector("img");
    return fallback instanceof HTMLImageElement ? fallback : null;
  }
  function getImageUrlFromElement(startElement) {
    if (!isElement(startElement)) return null;
    if (refs.overlay && refs.overlay.contains(startElement)) return null;
    let node = startElement;
    let depth = 0;
    while (node && depth <= CONFIG.maxAncestorSearchDepth) {
      if (node instanceof HTMLImageElement) {
        const selfImgUrl = getBestImageUrlFromImg(node);
        if (selfImgUrl) return selfImgUrl;
      }
      if (depth <= CONFIG.descendantSearchDepth) {
        const descendantImg = findDescendantImage(node);
        if (descendantImg) {
          const descendantImgUrl = getBestImageUrlFromImg(descendantImg);
          if (descendantImgUrl) return descendantImgUrl;
        }
      }
      const bgUrl = extractBackgroundImageUrl(node);
      if (bgUrl) return bgUrl;
      if (node === document.body) break;
      node = node.parentElement;
      depth += 1;
    }
    return null;
  }
  const DEFAULT_TIMEOUT_MS = 6e4;
  function createAbortError() {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  function normalizeHttpStatus(status) {
    return Number.isFinite(status) ? status : 0;
  }
  function normalizeMimeType(rawValue) {
    if (!rawValue) return null;
    const mimeType = rawValue.split(";")[0]?.trim().toLowerCase() ?? "";
    return mimeType || null;
  }
  function getResponseHeader(responseHeaders, headerName) {
    const targetName = headerName.trim().toLowerCase();
    if (!targetName) return null;
    for (const line of responseHeaders.split(/\r?\n/)) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex <= 0) continue;
      const currentName = line.slice(0, separatorIndex).trim().toLowerCase();
      if (currentName !== targetName) continue;
      const value = line.slice(separatorIndex + 1).trim();
      return value || null;
    }
    return null;
  }
  function inferMimeTypeFromUrl(imageUrl) {
    const cleanUrl = imageUrl.split("?")[0].split("#")[0].toLowerCase();
    if (cleanUrl.endsWith(".png")) return "image/png";
    if (cleanUrl.endsWith(".webp")) return "image/webp";
    if (cleanUrl.endsWith(".gif")) return "image/gif";
    if (cleanUrl.endsWith(".bmp")) return "image/bmp";
    if (cleanUrl.endsWith(".svg")) return "image/svg+xml";
    if (cleanUrl.endsWith(".jpg") || cleanUrl.endsWith(".jpeg")) return "image/jpeg";
    return "image/jpeg";
  }
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    if (!bytes.length) return "";
    let binary = "";
    const chunkSize = 32768;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return window.btoa(binary);
  }
  function textToBase64(value) {
    return arrayBufferToBase64(new TextEncoder().encode(value).buffer);
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("图片编码失败。"));
          return;
        }
        const commaIndex = reader.result.indexOf(",");
        const base64Data = commaIndex >= 0 ? reader.result.slice(commaIndex + 1).trim() : "";
        if (!base64Data) {
          reject(new Error("图片编码失败，未获取到有效数据。"));
          return;
        }
        resolve(base64Data);
      };
      reader.onerror = () => {
        reject(new Error("图片编码失败。"));
      };
      reader.readAsDataURL(blob);
    });
  }
  function decodeDataUrlImage(imageUrl) {
    if (!/^data:/i.test(imageUrl)) {
      return null;
    }
    const commaIndex = imageUrl.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("图片数据格式无效，无法解析。");
    }
    const metadata = imageUrl.slice(5, commaIndex);
    const dataPart = imageUrl.slice(commaIndex + 1);
    const metadataParts = metadata.split(";").map((item) => item.trim()).filter(Boolean);
    const mimeType = normalizeMimeType(metadataParts[0] ?? null) ?? "text/plain";
    if (!/^image\//i.test(mimeType)) {
      throw new Error("当前资源不是有效图片格式，暂不支持解释/翻译。");
    }
    const isBase64 = metadataParts.some((item) => item.toLowerCase() === "base64");
    const base64Data = isBase64 ? dataPart.replace(/\s+/g, "") : textToBase64(
      (() => {
        try {
          return decodeURIComponent(dataPart);
        } catch {
          return dataPart;
        }
      })()
    );
    if (!base64Data) {
      throw new Error("图片编码失败，未获取到有效数据。");
    }
    return {
      mimeType,
      base64Data
    };
  }
  function blobToInlineImagePayload(blob, fallbackMimeType) {
    const mimeType = normalizeMimeType(blob.type) ?? fallbackMimeType;
    if (!/^image\//i.test(mimeType)) {
      throw new Error("当前资源不是有效图片格式，暂不支持解释/翻译。");
    }
    return blobToBase64(blob).then((base64Data) => ({
      mimeType,
      base64Data
    }));
  }
  function requestLocalBlob(imageUrl, signal) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const cleanup = () => {
        signal?.removeEventListener("abort", handleAbortSignal);
      };
      const rejectWithAbort = () => {
        cleanup();
        reject(createAbortError());
      };
      const handleAbortSignal = () => {
        try {
          xhr.abort();
        } catch {
          rejectWithAbort();
        }
      };
      xhr.open("GET", imageUrl, true);
      xhr.responseType = "blob";
      xhr.onload = () => {
        cleanup();
        if (!(xhr.response instanceof Blob) || xhr.response.size <= 0) {
          reject(new Error("图片数据为空，无法解析。"));
          return;
        }
        const status = normalizeHttpStatus(xhr.status);
        if (status !== 0 && (status < 200 || status >= 300)) {
          reject(new Error(`图片加载失败（HTTP ${status}）。`));
          return;
        }
        resolve(xhr.response);
      };
      xhr.onerror = () => {
        cleanup();
        reject(new Error("无法读取本地 blob 图片内容。"));
      };
      xhr.onabort = () => {
        rejectWithAbort();
      };
      if (signal) {
        if (signal.aborted) {
          handleAbortSignal();
          return;
        }
        signal.addEventListener("abort", handleAbortSignal, { once: true });
      }
      xhr.send();
    });
  }
  function userscriptRequest(options) {
    if (typeof _GM_xmlhttpRequest !== "function") {
      throw new Error(
        "当前脚本环境不支持 GM_xmlhttpRequest。请确认已在用户脚本管理器中安装并授予权限。"
      );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        options.signal?.removeEventListener("abort", handleAbortSignal);
      };
      const settleResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleReject = (error2) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error2);
      };
      const request = _GM_xmlhttpRequest({
        method: options.method ?? "GET",
        url: options.url,
        headers: options.headers,
        data: options.data ?? void 0,
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        anonymous: options.anonymous ?? true,
        responseType: options.responseType ?? "text",
        onload: (event) => {
          settleResolve({
            status: normalizeHttpStatus(event.status),
            statusText: event.statusText,
            responseHeaders: event.responseHeaders,
            responseText: event.responseText,
            response: event.response,
            finalUrl: event.finalUrl
          });
        },
        onerror: (event) => {
          const status = normalizeHttpStatus(event.status);
          const message = status ? `请求失败（HTTP ${status} ${event.statusText || ""}）。`.trim() : "请求失败，可能未被用户脚本管理器授权访问该域名。";
          settleReject(new Error(message));
        },
        ontimeout: () => {
          settleReject(new Error("请求超时，请稍后重试。"));
        },
        onabort: () => {
          settleReject(createAbortError());
        }
      });
      const handleAbortSignal = () => {
        try {
          request.abort();
        } catch {
          settleReject(createAbortError());
        }
      };
      if (options.signal) {
        if (options.signal.aborted) {
          handleAbortSignal();
          return;
        }
        options.signal.addEventListener("abort", handleAbortSignal, { once: true });
      }
    });
  }
  function ensureSuccessStatus(status, fallbackMessage) {
    if (status >= 200 && status < 300) {
      return;
    }
    throw new Error(`${fallbackMessage}（HTTP ${status || 0}）。`);
  }
  function buildGoogleGenAiEndpoint(baseUrl, model, stream) {
    const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const versionedBaseUrl = /\/v\d+(alpha|beta)?$/i.test(trimmedBaseUrl) ? trimmedBaseUrl : `${trimmedBaseUrl}/v1beta`;
    const normalizedModel = model.trim().startsWith("models/") ? model.trim() : `models/${model.trim()}`;
    const encodedModel = normalizedModel.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    const method = "streamGenerateContent";
    const query = "?alt=sse";
    return `${versionedBaseUrl}/${encodedModel}:${method}${query}`;
  }
  function buildHttpErrorMessage(status, statusText) {
    const normalizedStatus = normalizeHttpStatus(status);
    return normalizedStatus ? `请求失败（HTTP ${normalizedStatus} ${statusText || ""}）。`.trim() : "请求失败，可能未被用户脚本管理器授权访问该域名。";
  }
  function createSseTextParser(callbacks) {
    let buffer = "";
    let eventName = "message";
    let dataLines = [];
    const emitEvent = () => {
      if (dataLines.length <= 0) {
        eventName = "message";
        return;
      }
      const eventData = dataLines.join("\n");
      callbacks.onEvent?.(eventName, eventData);
      callbacks.onData?.(eventData);
      eventName = "message";
      dataLines = [];
    };
    const consumeLine = (line) => {
      const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!normalizedLine) {
        emitEvent();
        return;
      }
      if (normalizedLine.startsWith(":")) {
        return;
      }
      const separatorIndex = normalizedLine.indexOf(":");
      const field = separatorIndex >= 0 ? normalizedLine.slice(0, separatorIndex) : normalizedLine;
      let value = separatorIndex >= 0 ? normalizedLine.slice(separatorIndex + 1) : "";
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      if (field === "event") {
        eventName = value || "message";
        return;
      }
      if (field === "data") {
        dataLines.push(value);
      }
    };
    const processBuffer = (flushRemainder = false) => {
      while (true) {
        const lineEndIndex = buffer.indexOf("\n");
        if (lineEndIndex < 0) {
          break;
        }
        const line = buffer.slice(0, lineEndIndex);
        buffer = buffer.slice(lineEndIndex + 1);
        consumeLine(line);
      }
      if (flushRemainder) {
        if (buffer) {
          consumeLine(buffer);
          buffer = "";
        }
        emitEvent();
      }
    };
    return {
      pushText: (text2) => {
        if (!text2) return;
        buffer += text2;
        processBuffer(false);
      },
      flush: () => {
        processBuffer(true);
      }
    };
  }
  function asReadableUint8Stream(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const stream = value;
    if (typeof stream.getReader !== "function") {
      return null;
    }
    return stream;
  }
  function requestUserscriptSse(options, callbacks) {
    if (typeof _GM_xmlhttpRequest !== "function") {
      const error2 = new Error(
        "当前脚本环境不支持 GM_xmlhttpRequest。请确认已在用户脚本管理器中安装并授予权限。"
      );
      callbacks.onError?.(error2);
      return {
        abort: () => {
        },
        promise: Promise.reject(error2)
      };
    }
    let settled = false;
    let aborted = false;
    let usingReadableStream = false;
    let lastResponseText = "";
    let gmRequest = null;
    let streamReader = null;
    let resolvePromise = null;
    let rejectPromise = null;
    const cleanup = () => {
      if (options.signal) {
        options.signal.removeEventListener("abort", handleAbortSignal);
      }
    };
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      callbacks.onComplete?.();
      resolvePromise?.();
    };
    const settleReject = (error2) => {
      if (settled) return;
      settled = true;
      cleanup();
      callbacks.onError?.(error2);
      rejectPromise?.(error2);
    };
    const finalizeSuccess = (responseText) => {
      if (aborted || settled) {
        return;
      }
      appendResponseText(responseText);
      parser.flush();
      settleResolve();
      stopTransport();
    };
    const stopTransport = () => {
      if (streamReader) {
        void streamReader.cancel().catch(() => {
        });
      }
      if (gmRequest) {
        try {
          gmRequest.abort();
        } catch {
        }
      }
    };
    const finishByDoneSignal = () => {
      if (aborted || settled) return;
      finalizeSuccess();
    };
    const parser = createSseTextParser({
      onEvent: (event, data) => {
        callbacks.onEvent?.(event, data);
      },
      onData: (data) => {
        if (data.trim() === "[DONE]") {
          finishByDoneSignal();
          return;
        }
        callbacks.onData?.(data);
      }
    });
    const handleAbortSignal = () => {
      if (aborted) return;
      aborted = true;
      stopTransport();
      settleReject(createAbortError());
    };
    const appendResponseText = (responseText) => {
      if (aborted || settled) return;
      const nextResponseText = responseText ?? "";
      if (!nextResponseText) {
        return;
      }
      const newText = nextResponseText.startsWith(lastResponseText) ? nextResponseText.slice(lastResponseText.length) : nextResponseText;
      lastResponseText = nextResponseText;
      if (!newText) {
        return;
      }
      parser.pushText(newText);
    };
    const consumeReadableStream = (stream) => {
      if (aborted || settled) {
        return;
      }
      usingReadableStream = true;
      streamReader = stream.getReader();
      const textDecoder = new TextDecoder();
      void (async () => {
        try {
          while (!aborted && !settled) {
            const { done, value } = await streamReader.read();
            if (aborted || settled) {
              return;
            }
            if (done) {
              break;
            }
            if (value && value.byteLength > 0) {
              const chunkText = textDecoder.decode(value, { stream: true });
              if (chunkText) {
                if (aborted || settled) {
                  return;
                }
                parser.pushText(chunkText);
              }
            }
          }
          if (aborted || settled) {
            return;
          }
          const tailText = textDecoder.decode();
          if (tailText) {
            parser.pushText(tailText);
          }
          finalizeSuccess();
        } catch (error2) {
          if (aborted || settled) {
            return;
          }
          const streamError = error2 instanceof Error ? error2 : new Error("读取流式响应失败。");
          settleReject(streamError);
        } finally {
          try {
            streamReader?.releaseLock();
          } catch {
          }
          streamReader = null;
        }
      })();
    };
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = (error2) => {
        reject(error2);
      };
      gmRequest = _GM_xmlhttpRequest({
        method: options.method ?? "POST",
        url: options.url,
        headers: options.headers,
        data: options.data ?? void 0,
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        anonymous: options.anonymous ?? false,
        responseType: "stream",
        onloadstart: (event) => {
          if (aborted || settled || usingReadableStream) {
            return;
          }
          const stream = asReadableUint8Stream(event.response);
          if (!stream) {
            return;
          }
          consumeReadableStream(stream);
        },
        onload: (event) => {
          if (aborted || settled) {
            return;
          }
          const status = normalizeHttpStatus(event.status);
          if (status && (status < 200 || status >= 300)) {
            settleReject(new Error(buildHttpErrorMessage(status, event.statusText)));
            return;
          }
          finalizeSuccess(event.responseText);
        },
        onloadend: () => {
          if (aborted || settled) {
            return;
          }
          finalizeSuccess();
        },
        onerror: (event) => {
          if (aborted || settled) {
            return;
          }
          settleReject(new Error(buildHttpErrorMessage(event.status, event.statusText)));
        },
        ontimeout: () => {
          if (aborted || settled) {
            return;
          }
          settleReject(new Error("请求超时，请稍后重试。"));
        },
        onabort: () => {
          if (settled) {
            return;
          }
          handleAbortSignal();
        },
        onprogress: (event) => {
          if (aborted || settled || usingReadableStream) {
            return;
          }
          appendResponseText(event.responseText);
        }
      });
      if (options.signal) {
        if (options.signal.aborted) {
          handleAbortSignal();
          return;
        }
        options.signal.addEventListener("abort", handleAbortSignal, { once: true });
      }
    });
    return {
      abort: handleAbortSignal,
      promise
    };
  }
  function requestUserscriptSseStream(options, onData) {
    return requestUserscriptSse(options, {
      onData
    });
  }
  async function fetchInlineImagePayloadViaUserscript(imageUrl, signal) {
    const dataUrlPayload = decodeDataUrlImage(imageUrl);
    if (dataUrlPayload) {
      return dataUrlPayload;
    }
    if (/^blob:/i.test(imageUrl)) {
      const blob = await requestLocalBlob(imageUrl, signal);
      return blobToInlineImagePayload(blob, inferMimeTypeFromUrl(imageUrl));
    }
    let response;
    try {
      response = await userscriptRequest({
        method: "GET",
        url: imageUrl,
        responseType: "arraybuffer",
        headers: {
          Accept: "image/*,*/*;q=0.8"
        },
        signal
      });
    } catch (error2) {
      if (error2 instanceof DOMException && error2.name === "AbortError") {
        throw error2;
      }
      throw new Error("无法读取图片内容，可能未授权访问该图片域名。请确认脚本已允许跨域连接后重试。");
    }
    ensureSuccessStatus(response.status, "图片加载失败");
    const imageBuffer = response.response;
    if (!(imageBuffer instanceof ArrayBuffer) || imageBuffer.byteLength <= 0) {
      throw new Error("图片数据为空，无法解析。");
    }
    const contentTypeHeader = normalizeMimeType(
      getResponseHeader(response.responseHeaders, "content-type")
    );
    const mimeType = contentTypeHeader && contentTypeHeader !== "application/octet-stream" ? contentTypeHeader : inferMimeTypeFromUrl(response.finalUrl || imageUrl);
    if (!/^image\//i.test(mimeType)) {
      throw new Error("当前资源不是有效图片格式，暂不支持解释/翻译。");
    }
    const base64Data = arrayBufferToBase64(imageBuffer);
    if (!base64Data) {
      throw new Error("图片编码失败，未获取到有效数据。");
    }
    return {
      mimeType,
      base64Data
    };
  }
  const IMAGE_TASK_PROMPTS = {
    explain: [
      "请用中文解释这张图片。",
      "请描述主体、场景、细节、风格与可能表达的意图。",
      "不确定的内容请明确标注“可能是…”。"
    ].join("\n"),
    translate: [
      "请识别这张图片里的文字并翻译成中文。",
      "请按“原文 -> 中文”逐条列出；无法识别的文字请写“[无法识别]”。",
      "如果图片里没有可读文字，请只回复“未检测到可翻译文字”。"
    ].join("\n")
  };
  function sanitizeConfig(base2) {
    const safeBaseUrl = base2.baseUrl.trim();
    const safeProvider = base2.provider.trim();
    const safeModel = base2.model.trim();
    const safeApiKey = base2.apiKey.trim();
    const safeSystemPrompt = base2.systemPrompt.trim();
    return {
      ...base2,
      provider: safeProvider || CONFIG.defaultAiConfig.provider,
      baseUrl: safeBaseUrl || CONFIG.defaultAiConfig.baseUrl,
      apiKey: safeApiKey,
      model: safeModel || CONFIG.defaultAiConfig.model,
      systemPrompt: safeSystemPrompt,
      temperature: clamp(base2.temperature, 0, 2)
    };
  }
  function resolveAiConfig(overrides) {
    const merged = {
      ...CONFIG.defaultAiConfig,
      ...state.aiConfig,
      ...overrides
    };
    return sanitizeConfig(merged);
  }
  function buildGoogleSearchGroundingTools(config2) {
    if (!config2.enableGoogleSearchGrounding) return void 0;
    return [
      {
        googleSearch: {}
      }
    ];
  }
  function buildImageTaskPrompt(taskType, extraPrompt) {
    const basePrompt = IMAGE_TASK_PROMPTS[taskType];
    const safeExtraPrompt = extraPrompt?.trim();
    if (!safeExtraPrompt) {
      return basePrompt;
    }
    return `${basePrompt}

补充要求：
${safeExtraPrompt}`;
  }
  function sanitizeInlineImagePayload(payload) {
    const mimeType = payload.mimeType.trim() || "image/jpeg";
    const base64Data = payload.base64Data.trim();
    if (!base64Data) {
      throw new Error("图片数据为空，无法发起 AI 请求。");
    }
    if (!/^image\//i.test(mimeType)) {
      throw new Error(`不支持的图片 MIME 类型：${mimeType}`);
    }
    return {
      mimeType,
      base64Data
    };
  }
  function mergeStreamText(previous, incoming) {
    if (!incoming) return previous;
    if (!previous) return incoming;
    if (incoming === previous) return previous;
    if (incoming.startsWith(previous)) {
      return incoming;
    }
    if (previous.endsWith(incoming)) {
      return previous;
    }
    return `${previous}${incoming}`;
  }
  function buildGoogleGenAiRequestBody(contents, config2) {
    const tools = buildGoogleSearchGroundingTools(config2);
    return {
      contents,
      generationConfig: {
        temperature: config2.temperature
      },
      ...config2.systemPrompt ? {
        systemInstruction: {
          parts: [
            {
              text: config2.systemPrompt
            }
          ]
        }
      } : {},
      ...tools ? { tools } : {}
    };
  }
  function buildGoogleGenAiImageRequest(image2, taskType, config2, extraPrompt) {
    const safeImage = sanitizeInlineImagePayload(image2);
    const prompt = buildImageTaskPrompt(taskType, extraPrompt);
    return buildGoogleGenAiRequestBody(
      [
        {
          role: "user",
          parts: [
            {
              text: prompt
            },
            {
              inlineData: {
                mimeType: safeImage.mimeType,
                data: safeImage.base64Data
              }
            }
          ]
        }
      ],
      config2
    );
  }
  function ensureGoogleGenAiConfig(config2) {
    if (!config2.apiKey) {
      throw new Error("Google GenAI API Key 为空，请先在 AI 设置中填写 API Key。");
    }
  }
  function extractGoogleGenAiStreamChunkText(chunk) {
    const firstCandidate = chunk.candidates?.[0];
    const parts = firstCandidate?.content?.parts;
    if (!Array.isArray(parts) || parts.length <= 0) {
      return "";
    }
    return parts.map((part) => typeof part?.text === "string" ? part.text : "").join("").trim();
  }
  async function executeGoogleGenAiStreamRequest(options) {
    ensureGoogleGenAiConfig(options.config);
    const url = buildGoogleGenAiEndpoint(options.config.baseUrl, options.config.model);
    let aggregatedText = "";
    let lastError = null;
    const handle = requestUserscriptSseStream(
      {
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": options.config.apiKey
        },
        data: JSON.stringify(options.request),
        signal: options.abortSignal
      },
      (data) => {
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        if (chunk.error) {
          const message = chunk.error.message?.trim() || "Google GenAI 流式请求返回错误。";
          lastError = new Error(message);
          handle.abort();
          return;
        }
        const chunkText = extractGoogleGenAiStreamChunkText(chunk);
        if (!chunkText) return;
        aggregatedText = mergeStreamText(aggregatedText, chunkText);
        options.onChunk?.(aggregatedText, chunkText);
      }
    );
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        handle.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      options.abortSignal.addEventListener(
        "abort",
        () => {
          handle.abort();
        },
        { once: true }
      );
    }
    try {
      await handle.promise;
    } catch (error2) {
      if (lastError) {
        throw lastError;
      }
      if (error2 instanceof DOMException && error2.name === "AbortError") {
        throw error2;
      }
      throw error2 instanceof Error ? error2 : new Error("Google GenAI 流式请求失败。");
    }
    if (lastError) {
      throw lastError;
    }
    return aggregatedText.trim();
  }
  async function generateImageTaskStreamWithConfiguredAi(options) {
    const resolvedConfig = resolveAiConfig(options.overrides);
    if (!resolvedConfig.enabled) {
      throw new Error("AI 功能未启用，请先在 AI 设置中开启。");
    }
    if (resolvedConfig.apiFormat === "google-genai") {
      const request = buildGoogleGenAiImageRequest(
        options.image,
        options.taskType,
        resolvedConfig,
        options.extraPrompt
      );
      return executeGoogleGenAiStreamRequest({
        request,
        config: resolvedConfig,
        abortSignal: options.abortSignal,
        onChunk: options.onChunk
      });
    }
    throw new Error("当前仅实现了 google-genai API 格式，openai-compatible 适配待实现。");
  }
  const decodeCache = {};
  function getDecodeCache(exclude) {
    let cache = decodeCache[exclude];
    if (cache) {
      return cache;
    }
    cache = decodeCache[exclude] = [];
    for (let i = 0; i < 128; i++) {
      const ch = String.fromCharCode(i);
      cache.push(ch);
    }
    for (let i = 0; i < exclude.length; i++) {
      const ch = exclude.charCodeAt(i);
      cache[ch] = "%" + ("0" + ch.toString(16).toUpperCase()).slice(-2);
    }
    return cache;
  }
  function decode$1(string, exclude) {
    if (typeof exclude !== "string") {
      exclude = decode$1.defaultChars;
    }
    const cache = getDecodeCache(exclude);
    return string.replace(/(%[a-f0-9]{2})+/gi, function(seq) {
      let result = "";
      for (let i = 0, l = seq.length; i < l; i += 3) {
        const b1 = parseInt(seq.slice(i + 1, i + 3), 16);
        if (b1 < 128) {
          result += cache[b1];
          continue;
        }
        if ((b1 & 224) === 192 && i + 3 < l) {
          const b2 = parseInt(seq.slice(i + 4, i + 6), 16);
          if ((b2 & 192) === 128) {
            const chr = b1 << 6 & 1984 | b2 & 63;
            if (chr < 128) {
              result += "��";
            } else {
              result += String.fromCharCode(chr);
            }
            i += 3;
            continue;
          }
        }
        if ((b1 & 240) === 224 && i + 6 < l) {
          const b2 = parseInt(seq.slice(i + 4, i + 6), 16);
          const b3 = parseInt(seq.slice(i + 7, i + 9), 16);
          if ((b2 & 192) === 128 && (b3 & 192) === 128) {
            const chr = b1 << 12 & 61440 | b2 << 6 & 4032 | b3 & 63;
            if (chr < 2048 || chr >= 55296 && chr <= 57343) {
              result += "���";
            } else {
              result += String.fromCharCode(chr);
            }
            i += 6;
            continue;
          }
        }
        if ((b1 & 248) === 240 && i + 9 < l) {
          const b2 = parseInt(seq.slice(i + 4, i + 6), 16);
          const b3 = parseInt(seq.slice(i + 7, i + 9), 16);
          const b4 = parseInt(seq.slice(i + 10, i + 12), 16);
          if ((b2 & 192) === 128 && (b3 & 192) === 128 && (b4 & 192) === 128) {
            let chr = b1 << 18 & 1835008 | b2 << 12 & 258048 | b3 << 6 & 4032 | b4 & 63;
            if (chr < 65536 || chr > 1114111) {
              result += "����";
            } else {
              chr -= 65536;
              result += String.fromCharCode(55296 + (chr >> 10), 56320 + (chr & 1023));
            }
            i += 9;
            continue;
          }
        }
        result += "�";
      }
      return result;
    });
  }
  decode$1.defaultChars = ";/?:@&=+$,#";
  decode$1.componentChars = "";
  const encodeCache = {};
  function getEncodeCache(exclude) {
    let cache = encodeCache[exclude];
    if (cache) {
      return cache;
    }
    cache = encodeCache[exclude] = [];
    for (let i = 0; i < 128; i++) {
      const ch = String.fromCharCode(i);
      if (/^[0-9a-z]$/i.test(ch)) {
        cache.push(ch);
      } else {
        cache.push("%" + ("0" + i.toString(16).toUpperCase()).slice(-2));
      }
    }
    for (let i = 0; i < exclude.length; i++) {
      cache[exclude.charCodeAt(i)] = exclude[i];
    }
    return cache;
  }
  function encode$1(string, exclude, keepEscaped) {
    if (typeof exclude !== "string") {
      keepEscaped = exclude;
      exclude = encode$1.defaultChars;
    }
    if (typeof keepEscaped === "undefined") {
      keepEscaped = true;
    }
    const cache = getEncodeCache(exclude);
    let result = "";
    for (let i = 0, l = string.length; i < l; i++) {
      const code2 = string.charCodeAt(i);
      if (keepEscaped && code2 === 37 && i + 2 < l) {
        if (/^[0-9a-f]{2}$/i.test(string.slice(i + 1, i + 3))) {
          result += string.slice(i, i + 3);
          i += 2;
          continue;
        }
      }
      if (code2 < 128) {
        result += cache[code2];
        continue;
      }
      if (code2 >= 55296 && code2 <= 57343) {
        if (code2 >= 55296 && code2 <= 56319 && i + 1 < l) {
          const nextCode = string.charCodeAt(i + 1);
          if (nextCode >= 56320 && nextCode <= 57343) {
            result += encodeURIComponent(string[i] + string[i + 1]);
            i++;
            continue;
          }
        }
        result += "%EF%BF%BD";
        continue;
      }
      result += encodeURIComponent(string[i]);
    }
    return result;
  }
  encode$1.defaultChars = ";/?:@&=+$,-_.!~*'()#";
  encode$1.componentChars = "-_.!~*'()";
  function format(url) {
    let result = "";
    result += url.protocol || "";
    result += url.slashes ? "//" : "";
    result += url.auth ? url.auth + "@" : "";
    if (url.hostname && url.hostname.indexOf(":") !== -1) {
      result += "[" + url.hostname + "]";
    } else {
      result += url.hostname || "";
    }
    result += url.port ? ":" + url.port : "";
    result += url.pathname || "";
    result += url.search || "";
    result += url.hash || "";
    return result;
  }
  function Url() {
    this.protocol = null;
    this.slashes = null;
    this.auth = null;
    this.port = null;
    this.hostname = null;
    this.hash = null;
    this.search = null;
    this.pathname = null;
  }
  const protocolPattern = /^([a-z0-9.+-]+:)/i;
  const portPattern = /:[0-9]*$/;
  const simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/;
  const delims = ["<", ">", '"', "`", " ", "\r", "\n", "	"];
  const unwise = ["{", "}", "|", "\\", "^", "`"].concat(delims);
  const autoEscape = ["'"].concat(unwise);
  const nonHostChars = ["%", "/", "?", ";", "#"].concat(autoEscape);
  const hostEndingChars = ["/", "?", "#"];
  const hostnameMaxLen = 255;
  const hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/;
  const hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/;
  const hostlessProtocol = {
    javascript: true,
    "javascript:": true
  };
  const slashedProtocol = {
    http: true,
    https: true,
    ftp: true,
    gopher: true,
    file: true,
    "http:": true,
    "https:": true,
    "ftp:": true,
    "gopher:": true,
    "file:": true
  };
  function urlParse(url, slashesDenoteHost) {
    if (url && url instanceof Url) return url;
    const u = new Url();
    u.parse(url, slashesDenoteHost);
    return u;
  }
  Url.prototype.parse = function(url, slashesDenoteHost) {
    let lowerProto, hec, slashes;
    let rest = url;
    rest = rest.trim();
    if (!slashesDenoteHost && url.split("#").length === 1) {
      const simplePath = simplePathPattern.exec(rest);
      if (simplePath) {
        this.pathname = simplePath[1];
        if (simplePath[2]) {
          this.search = simplePath[2];
        }
        return this;
      }
    }
    let proto = protocolPattern.exec(rest);
    if (proto) {
      proto = proto[0];
      lowerProto = proto.toLowerCase();
      this.protocol = proto;
      rest = rest.substr(proto.length);
    }
    if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
      slashes = rest.substr(0, 2) === "//";
      if (slashes && !(proto && hostlessProtocol[proto])) {
        rest = rest.substr(2);
        this.slashes = true;
      }
    }
    if (!hostlessProtocol[proto] && (slashes || proto && !slashedProtocol[proto])) {
      let hostEnd = -1;
      for (let i = 0; i < hostEndingChars.length; i++) {
        hec = rest.indexOf(hostEndingChars[i]);
        if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) {
          hostEnd = hec;
        }
      }
      let auth, atSign;
      if (hostEnd === -1) {
        atSign = rest.lastIndexOf("@");
      } else {
        atSign = rest.lastIndexOf("@", hostEnd);
      }
      if (atSign !== -1) {
        auth = rest.slice(0, atSign);
        rest = rest.slice(atSign + 1);
        this.auth = auth;
      }
      hostEnd = -1;
      for (let i = 0; i < nonHostChars.length; i++) {
        hec = rest.indexOf(nonHostChars[i]);
        if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) {
          hostEnd = hec;
        }
      }
      if (hostEnd === -1) {
        hostEnd = rest.length;
      }
      if (rest[hostEnd - 1] === ":") {
        hostEnd--;
      }
      const host = rest.slice(0, hostEnd);
      rest = rest.slice(hostEnd);
      this.parseHost(host);
      this.hostname = this.hostname || "";
      const ipv6Hostname = this.hostname[0] === "[" && this.hostname[this.hostname.length - 1] === "]";
      if (!ipv6Hostname) {
        const hostparts = this.hostname.split(/\./);
        for (let i = 0, l = hostparts.length; i < l; i++) {
          const part = hostparts[i];
          if (!part) {
            continue;
          }
          if (!part.match(hostnamePartPattern)) {
            let newpart = "";
            for (let j = 0, k = part.length; j < k; j++) {
              if (part.charCodeAt(j) > 127) {
                newpart += "x";
              } else {
                newpart += part[j];
              }
            }
            if (!newpart.match(hostnamePartPattern)) {
              const validParts = hostparts.slice(0, i);
              const notHost = hostparts.slice(i + 1);
              const bit = part.match(hostnamePartStart);
              if (bit) {
                validParts.push(bit[1]);
                notHost.unshift(bit[2]);
              }
              if (notHost.length) {
                rest = notHost.join(".") + rest;
              }
              this.hostname = validParts.join(".");
              break;
            }
          }
        }
      }
      if (this.hostname.length > hostnameMaxLen) {
        this.hostname = "";
      }
      if (ipv6Hostname) {
        this.hostname = this.hostname.substr(1, this.hostname.length - 2);
      }
    }
    const hash = rest.indexOf("#");
    if (hash !== -1) {
      this.hash = rest.substr(hash);
      rest = rest.slice(0, hash);
    }
    const qm = rest.indexOf("?");
    if (qm !== -1) {
      this.search = rest.substr(qm);
      rest = rest.slice(0, qm);
    }
    if (rest) {
      this.pathname = rest;
    }
    if (slashedProtocol[lowerProto] && this.hostname && !this.pathname) {
      this.pathname = "";
    }
    return this;
  };
  Url.prototype.parseHost = function(host) {
    let port = portPattern.exec(host);
    if (port) {
      port = port[0];
      if (port !== ":") {
        this.port = port.substr(1);
      }
      host = host.substr(0, host.length - port.length);
    }
    if (host) {
      this.hostname = host;
    }
  };
  const mdurl = Object.freeze( Object.defineProperty({
    __proto__: null,
    decode: decode$1,
    encode: encode$1,
    format,
    parse: urlParse
  }, Symbol.toStringTag, { value: "Module" }));
  const Any = /[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
  const Cc = /[\0-\x1F\x7F-\x9F]/;
  const regex$1 = /[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/;
  const P = /[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1B7D\u1B7E\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDEAD\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD83A[\uDD5E\uDD5F]/;
  const regex = /[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C0\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2426\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2B95\u2B97-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E3\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBC2\uFD40-\uFD4F\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED7\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDF76\uDF7B-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0\uDCB1\uDD00-\uDE53\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE88\uDE90-\uDEBD\uDEBF-\uDEC5\uDECE-\uDEDB\uDEE0-\uDEE8\uDEF0-\uDEF8\uDF00-\uDF92\uDF94-\uDFCA]/;
  const Z = /[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
  const ucmicro = Object.freeze( Object.defineProperty({
    __proto__: null,
    Any,
    Cc,
    Cf: regex$1,
    P,
    S: regex,
    Z
  }, Symbol.toStringTag, { value: "Module" }));
  const htmlDecodeTree = new Uint16Array(
'ᵁ<Õıʊҝջאٵ۞ޢߖࠏ੊ઑඡ๭༉༦჊ረዡᐕᒝᓃᓟᔥ\0\0\0\0\0\0ᕫᛍᦍᰒᷝ὾⁠↰⊍⏀⏻⑂⠤⤒ⴈ⹈⿎〖㊺㘹㞬㣾㨨㩱㫠㬮ࠀEMabcfglmnoprstu\\bfms¦³¹ÈÏlig耻Æ䃆P耻&䀦cute耻Á䃁reve;䄂Āiyx}rc耻Â䃂;䐐r;쀀𝔄rave耻À䃀pha;䎑acr;䄀d;橓Āgp¡on;䄄f;쀀𝔸plyFunction;恡ing耻Å䃅Ācs¾Ãr;쀀𝒜ign;扔ilde耻Ã䃃ml耻Ä䃄ЀaceforsuåûþėĜĢħĪĀcrêòkslash;或Ŷöø;櫧ed;挆y;䐑ƀcrtąċĔause;戵noullis;愬a;䎒r;쀀𝔅pf;쀀𝔹eve;䋘còēmpeq;扎܀HOacdefhilorsuōőŖƀƞƢƵƷƺǜȕɳɸɾcy;䐧PY耻©䂩ƀcpyŝŢźute;䄆Ā;iŧŨ拒talDifferentialD;慅leys;愭ȀaeioƉƎƔƘron;䄌dil耻Ç䃇rc;䄈nint;戰ot;䄊ĀdnƧƭilla;䂸terDot;䂷òſi;䎧rcleȀDMPTǇǋǑǖot;抙inus;抖lus;投imes;抗oĀcsǢǸkwiseContourIntegral;戲eCurlyĀDQȃȏoubleQuote;思uote;怙ȀlnpuȞȨɇɕonĀ;eȥȦ户;橴ƀgitȯȶȺruent;扡nt;戯ourIntegral;戮ĀfrɌɎ;愂oduct;成nterClockwiseContourIntegral;戳oss;樯cr;쀀𝒞pĀ;Cʄʅ拓ap;才րDJSZacefiosʠʬʰʴʸˋ˗ˡ˦̳ҍĀ;oŹʥtrahd;椑cy;䐂cy;䐅cy;䐏ƀgrsʿ˄ˇger;怡r;憡hv;櫤Āayː˕ron;䄎;䐔lĀ;t˝˞戇a;䎔r;쀀𝔇Āaf˫̧Ācm˰̢riticalȀADGT̖̜̀̆cute;䂴oŴ̋̍;䋙bleAcute;䋝rave;䁠ilde;䋜ond;拄ferentialD;慆Ѱ̽\0\0\0͔͂\0Ѕf;쀀𝔻ƀ;DE͈͉͍䂨ot;惜qual;扐blèCDLRUVͣͲ΂ϏϢϸontourIntegraìȹoɴ͹\0\0ͻ»͉nArrow;懓Āeo·ΤftƀARTΐΖΡrrow;懐ightArrow;懔eåˊngĀLRΫτeftĀARγιrrow;柸ightArrow;柺ightArrow;柹ightĀATϘϞrrow;懒ee;抨pɁϩ\0\0ϯrrow;懑ownArrow;懕erticalBar;戥ǹABLRTaВЪаўѿͼrrowƀ;BUНОТ憓ar;椓pArrow;懵reve;䌑eft˒к\0ц\0ѐightVector;楐eeVector;楞ectorĀ;Bљњ憽ar;楖ightǔѧ\0ѱeeVector;楟ectorĀ;BѺѻ懁ar;楗eeĀ;A҆҇护rrow;憧ĀctҒҗr;쀀𝒟rok;䄐ࠀNTacdfglmopqstuxҽӀӄӋӞӢӧӮӵԡԯԶՒ՝ՠեG;䅊H耻Ð䃐cute耻É䃉ƀaiyӒӗӜron;䄚rc耻Ê䃊;䐭ot;䄖r;쀀𝔈rave耻È䃈ement;戈ĀapӺӾcr;䄒tyɓԆ\0\0ԒmallSquare;旻erySmallSquare;斫ĀgpԦԪon;䄘f;쀀𝔼silon;䎕uĀaiԼՉlĀ;TՂՃ橵ilde;扂librium;懌Āci՗՚r;愰m;橳a;䎗ml耻Ë䃋Āipժկsts;戃onentialE;慇ʀcfiosօֈ֍ֲ׌y;䐤r;쀀𝔉lledɓ֗\0\0֣mallSquare;旼erySmallSquare;斪Ͱֺ\0ֿ\0\0ׄf;쀀𝔽All;戀riertrf;愱cò׋؀JTabcdfgorstר׬ׯ׺؀ؒؖ؛؝أ٬ٲcy;䐃耻>䀾mmaĀ;d׷׸䎓;䏜reve;䄞ƀeiy؇،ؐdil;䄢rc;䄜;䐓ot;䄠r;쀀𝔊;拙pf;쀀𝔾eater̀EFGLSTصلَٖٛ٦qualĀ;Lؾؿ扥ess;招ullEqual;执reater;檢ess;扷lantEqual;橾ilde;扳cr;쀀𝒢;扫ЀAacfiosuڅڋږڛڞڪھۊRDcy;䐪Āctڐڔek;䋇;䁞irc;䄤r;愌lbertSpace;愋ǰگ\0ڲf;愍izontalLine;攀Āctۃۅòکrok;䄦mpńېۘownHumðįqual;扏܀EJOacdfgmnostuۺ۾܃܇܎ܚܞܡܨ݄ݸދޏޕcy;䐕lig;䄲cy;䐁cute耻Í䃍Āiyܓܘrc耻Î䃎;䐘ot;䄰r;愑rave耻Ì䃌ƀ;apܠܯܿĀcgܴܷr;䄪inaryI;慈lieóϝǴ݉\0ݢĀ;eݍݎ戬Āgrݓݘral;戫section;拂isibleĀCTݬݲomma;恣imes;恢ƀgptݿރވon;䄮f;쀀𝕀a;䎙cr;愐ilde;䄨ǫޚ\0ޞcy;䐆l耻Ï䃏ʀcfosuެ޷޼߂ߐĀiyޱ޵rc;䄴;䐙r;쀀𝔍pf;쀀𝕁ǣ߇\0ߌr;쀀𝒥rcy;䐈kcy;䐄΀HJacfosߤߨ߽߬߱ࠂࠈcy;䐥cy;䐌ppa;䎚Āey߶߻dil;䄶;䐚r;쀀𝔎pf;쀀𝕂cr;쀀𝒦րJTaceflmostࠥࠩࠬࡐࡣ঳সে্਷ੇcy;䐉耻<䀼ʀcmnpr࠷࠼ࡁࡄࡍute;䄹bda;䎛g;柪lacetrf;愒r;憞ƀaeyࡗ࡜ࡡron;䄽dil;䄻;䐛Āfsࡨ॰tԀACDFRTUVarࡾࢩࢱࣦ࣠ࣼयज़ΐ४Ānrࢃ࢏gleBracket;柨rowƀ;BR࢙࢚࢞憐ar;懤ightArrow;懆eiling;挈oǵࢷ\0ࣃbleBracket;柦nǔࣈ\0࣒eeVector;楡ectorĀ;Bࣛࣜ懃ar;楙loor;挊ightĀAV࣯ࣵrrow;憔ector;楎Āerँगeƀ;AVउऊऐ抣rrow;憤ector;楚iangleƀ;BEतथऩ抲ar;槏qual;抴pƀDTVषूौownVector;楑eeVector;楠ectorĀ;Bॖॗ憿ar;楘ectorĀ;B॥०憼ar;楒ightáΜs̀EFGLSTॾঋকঝঢভqualGreater;拚ullEqual;扦reater;扶ess;檡lantEqual;橽ilde;扲r;쀀𝔏Ā;eঽা拘ftarrow;懚idot;䄿ƀnpw৔ਖਛgȀLRlr৞৷ਂਐeftĀAR০৬rrow;柵ightArrow;柷ightArrow;柶eftĀarγਊightáοightáϊf;쀀𝕃erĀLRਢਬeftArrow;憙ightArrow;憘ƀchtਾੀੂòࡌ;憰rok;䅁;扪Ѐacefiosuਗ਼੝੠੷੼અઋ઎p;椅y;䐜Ādl੥੯iumSpace;恟lintrf;愳r;쀀𝔐nusPlus;戓pf;쀀𝕄cò੶;䎜ҀJacefostuણધભીଔଙඑ඗ඞcy;䐊cute;䅃ƀaey઴હાron;䅇dil;䅅;䐝ƀgswે૰଎ativeƀMTV૓૟૨ediumSpace;怋hiĀcn૦૘ë૙eryThiî૙tedĀGL૸ଆreaterGreateòٳessLesóੈLine;䀊r;쀀𝔑ȀBnptଢନଷ଺reak;恠BreakingSpace;䂠f;愕ڀ;CDEGHLNPRSTV୕ୖ୪୼஡௫ఄ౞಄ದ೘ൡඅ櫬Āou୛୤ngruent;扢pCap;扭oubleVerticalBar;戦ƀlqxஃஊ஛ement;戉ualĀ;Tஒஓ扠ilde;쀀≂̸ists;戄reater΀;EFGLSTஶஷ஽௉௓௘௥扯qual;扱ullEqual;쀀≧̸reater;쀀≫̸ess;批lantEqual;쀀⩾̸ilde;扵umpń௲௽ownHump;쀀≎̸qual;쀀≏̸eĀfsఊధtTriangleƀ;BEచఛడ拪ar;쀀⧏̸qual;括s̀;EGLSTవశ఼ౄోౘ扮qual;扰reater;扸ess;쀀≪̸lantEqual;쀀⩽̸ilde;扴estedĀGL౨౹reaterGreater;쀀⪢̸essLess;쀀⪡̸recedesƀ;ESಒಓಛ技qual;쀀⪯̸lantEqual;拠ĀeiಫಹverseElement;戌ghtTriangleƀ;BEೋೌ೒拫ar;쀀⧐̸qual;拭ĀquೝഌuareSuĀbp೨೹setĀ;E೰ೳ쀀⊏̸qual;拢ersetĀ;Eഃആ쀀⊐̸qual;拣ƀbcpഓതൎsetĀ;Eഛഞ쀀⊂⃒qual;抈ceedsȀ;ESTലള഻െ抁qual;쀀⪰̸lantEqual;拡ilde;쀀≿̸ersetĀ;E൘൛쀀⊃⃒qual;抉ildeȀ;EFT൮൯൵ൿ扁qual;扄ullEqual;扇ilde;扉erticalBar;戤cr;쀀𝒩ilde耻Ñ䃑;䎝܀Eacdfgmoprstuvලෂ෉෕ෛ෠෧෼ขภยา฿ไlig;䅒cute耻Ó䃓Āiy෎ීrc耻Ô䃔;䐞blac;䅐r;쀀𝔒rave耻Ò䃒ƀaei෮ෲ෶cr;䅌ga;䎩cron;䎟pf;쀀𝕆enCurlyĀDQฎบoubleQuote;怜uote;怘;橔Āclวฬr;쀀𝒪ash耻Ø䃘iŬื฼de耻Õ䃕es;樷ml耻Ö䃖erĀBP๋๠Āar๐๓r;怾acĀek๚๜;揞et;掴arenthesis;揜Ҁacfhilors๿ງຊຏຒດຝະ໼rtialD;戂y;䐟r;쀀𝔓i;䎦;䎠usMinus;䂱Āipຢອncareplanåڝf;愙Ȁ;eio຺ູ໠໤檻cedesȀ;EST່້໏໚扺qual;檯lantEqual;扼ilde;找me;怳Ādp໩໮uct;戏ortionĀ;aȥ໹l;戝Āci༁༆r;쀀𝒫;䎨ȀUfos༑༖༛༟OT耻"䀢r;쀀𝔔pf;愚cr;쀀𝒬؀BEacefhiorsu༾གྷཇའཱིྦྷྪྭ႖ႩႴႾarr;椐G耻®䂮ƀcnrཎནབute;䅔g;柫rĀ;tཛྷཝ憠l;椖ƀaeyཧཬཱron;䅘dil;䅖;䐠Ā;vླྀཹ愜erseĀEUྂྙĀlq྇ྎement;戋uilibrium;懋pEquilibrium;楯r»ཹo;䎡ghtЀACDFTUVa࿁࿫࿳ဢဨၛႇϘĀnr࿆࿒gleBracket;柩rowƀ;BL࿜࿝࿡憒ar;懥eftArrow;懄eiling;按oǵ࿹\0စbleBracket;柧nǔည\0နeeVector;楝ectorĀ;Bဝသ懂ar;楕loor;挋Āerိ၃eƀ;AVဵံြ抢rrow;憦ector;楛iangleƀ;BEၐၑၕ抳ar;槐qual;抵pƀDTVၣၮၸownVector;楏eeVector;楜ectorĀ;Bႂႃ憾ar;楔ectorĀ;B႑႒懀ar;楓Āpuႛ႞f;愝ndImplies;楰ightarrow;懛ĀchႹႼr;愛;憱leDelayed;槴ڀHOacfhimoqstuფჱჷჽᄙᄞᅑᅖᅡᅧᆵᆻᆿĀCcჩხHcy;䐩y;䐨FTcy;䐬cute;䅚ʀ;aeiyᄈᄉᄎᄓᄗ檼ron;䅠dil;䅞rc;䅜;䐡r;쀀𝔖ortȀDLRUᄪᄴᄾᅉownArrow»ОeftArrow»࢚ightArrow»࿝pArrow;憑gma;䎣allCircle;战pf;쀀𝕊ɲᅭ\0\0ᅰt;戚areȀ;ISUᅻᅼᆉᆯ斡ntersection;抓uĀbpᆏᆞsetĀ;Eᆗᆘ抏qual;抑ersetĀ;Eᆨᆩ抐qual;抒nion;抔cr;쀀𝒮ar;拆ȀbcmpᇈᇛሉላĀ;sᇍᇎ拐etĀ;Eᇍᇕqual;抆ĀchᇠህeedsȀ;ESTᇭᇮᇴᇿ扻qual;檰lantEqual;扽ilde;承Tháྌ;我ƀ;esሒሓሣ拑rsetĀ;Eሜም抃qual;抇et»ሓրHRSacfhiorsሾቄ቉ቕ቞ቱቶኟዂወዑORN耻Þ䃞ADE;愢ĀHc቎ቒcy;䐋y;䐦Ābuቚቜ;䀉;䎤ƀaeyብቪቯron;䅤dil;䅢;䐢r;쀀𝔗Āeiቻ኉ǲኀ\0ኇefore;戴a;䎘Ācn኎ኘkSpace;쀀  Space;怉ldeȀ;EFTካኬኲኼ戼qual;扃ullEqual;扅ilde;扈pf;쀀𝕋ipleDot;惛Āctዖዛr;쀀𝒯rok;䅦ૡዷጎጚጦ\0ጬጱ\0\0\0\0\0ጸጽ፷ᎅ\0᏿ᐄᐊᐐĀcrዻጁute耻Ú䃚rĀ;oጇገ憟cir;楉rǣጓ\0጖y;䐎ve;䅬Āiyጞጣrc耻Û䃛;䐣blac;䅰r;쀀𝔘rave耻Ù䃙acr;䅪Ādiፁ፩erĀBPፈ፝Āarፍፐr;䁟acĀekፗፙ;揟et;掵arenthesis;揝onĀ;P፰፱拃lus;抎Āgp፻፿on;䅲f;쀀𝕌ЀADETadps᎕ᎮᎸᏄϨᏒᏗᏳrrowƀ;BDᅐᎠᎤar;椒ownArrow;懅ownArrow;憕quilibrium;楮eeĀ;AᏋᏌ报rrow;憥ownáϳerĀLRᏞᏨeftArrow;憖ightArrow;憗iĀ;lᏹᏺ䏒on;䎥ing;䅮cr;쀀𝒰ilde;䅨ml耻Ü䃜ҀDbcdefosvᐧᐬᐰᐳᐾᒅᒊᒐᒖash;披ar;櫫y;䐒ashĀ;lᐻᐼ抩;櫦Āerᑃᑅ;拁ƀbtyᑌᑐᑺar;怖Ā;iᑏᑕcalȀBLSTᑡᑥᑪᑴar;戣ine;䁼eparator;杘ilde;所ThinSpace;怊r;쀀𝔙pf;쀀𝕍cr;쀀𝒱dash;抪ʀcefosᒧᒬᒱᒶᒼirc;䅴dge;拀r;쀀𝔚pf;쀀𝕎cr;쀀𝒲Ȁfiosᓋᓐᓒᓘr;쀀𝔛;䎞pf;쀀𝕏cr;쀀𝒳ҀAIUacfosuᓱᓵᓹᓽᔄᔏᔔᔚᔠcy;䐯cy;䐇cy;䐮cute耻Ý䃝Āiyᔉᔍrc;䅶;䐫r;쀀𝔜pf;쀀𝕐cr;쀀𝒴ml;䅸ЀHacdefosᔵᔹᔿᕋᕏᕝᕠᕤcy;䐖cute;䅹Āayᕄᕉron;䅽;䐗ot;䅻ǲᕔ\0ᕛoWidtè૙a;䎖r;愨pf;愤cr;쀀𝒵௡ᖃᖊᖐ\0ᖰᖶᖿ\0\0\0\0ᗆᗛᗫᙟ᙭\0ᚕ᚛ᚲᚹ\0ᚾcute耻á䃡reve;䄃̀;Ediuyᖜᖝᖡᖣᖨᖭ戾;쀀∾̳;房rc耻â䃢te肻´̆;䐰lig耻æ䃦Ā;r²ᖺ;쀀𝔞rave耻à䃠ĀepᗊᗖĀfpᗏᗔsym;愵èᗓha;䎱ĀapᗟcĀclᗤᗧr;䄁g;樿ɤᗰ\0\0ᘊʀ;adsvᗺᗻᗿᘁᘇ戧nd;橕;橜lope;橘;橚΀;elmrszᘘᘙᘛᘞᘿᙏᙙ戠;榤e»ᘙsdĀ;aᘥᘦ戡ѡᘰᘲᘴᘶᘸᘺᘼᘾ;榨;榩;榪;榫;榬;榭;榮;榯tĀ;vᙅᙆ戟bĀ;dᙌᙍ抾;榝Āptᙔᙗh;戢»¹arr;捼Āgpᙣᙧon;䄅f;쀀𝕒΀;Eaeiop዁ᙻᙽᚂᚄᚇᚊ;橰cir;橯;扊d;手s;䀧roxĀ;e዁ᚒñᚃing耻å䃥ƀctyᚡᚦᚨr;쀀𝒶;䀪mpĀ;e዁ᚯñʈilde耻ã䃣ml耻ä䃤Āciᛂᛈoninôɲnt;樑ࠀNabcdefiklnoprsu᛭ᛱᜰ᜼ᝃᝈ᝸᝽០៦ᠹᡐᜍ᤽᥈ᥰot;櫭Ācrᛶ᜞kȀcepsᜀᜅᜍᜓong;扌psilon;䏶rime;怵imĀ;e᜚᜛戽q;拍Ŷᜢᜦee;抽edĀ;gᜬᜭ挅e»ᜭrkĀ;t፜᜷brk;掶Āoyᜁᝁ;䐱quo;怞ʀcmprtᝓ᝛ᝡᝤᝨausĀ;eĊĉptyv;榰séᜌnoõēƀahwᝯ᝱ᝳ;䎲;愶een;扬r;쀀𝔟g΀costuvwឍឝឳេ៕៛៞ƀaiuបពរðݠrc;旯p»፱ƀdptឤឨឭot;樀lus;樁imes;樂ɱឹ\0\0ើcup;樆ar;昅riangleĀdu៍្own;施p;斳plus;樄eåᑄåᒭarow;植ƀako៭ᠦᠵĀcn៲ᠣkƀlst៺֫᠂ozenge;槫riangleȀ;dlr᠒᠓᠘᠝斴own;斾eft;旂ight;斸k;搣Ʊᠫ\0ᠳƲᠯ\0ᠱ;斒;斑4;斓ck;斈ĀeoᠾᡍĀ;qᡃᡆ쀀=⃥uiv;쀀≡⃥t;挐Ȁptwxᡙᡞᡧᡬf;쀀𝕓Ā;tᏋᡣom»Ꮜtie;拈؀DHUVbdhmptuvᢅᢖᢪᢻᣗᣛᣬ᣿ᤅᤊᤐᤡȀLRlrᢎᢐᢒᢔ;敗;敔;敖;敓ʀ;DUduᢡᢢᢤᢦᢨ敐;敦;敩;敤;敧ȀLRlrᢳᢵᢷᢹ;敝;敚;敜;教΀;HLRhlrᣊᣋᣍᣏᣑᣓᣕ救;敬;散;敠;敫;敢;敟ox;槉ȀLRlrᣤᣦᣨᣪ;敕;敒;攐;攌ʀ;DUduڽ᣷᣹᣻᣽;敥;敨;攬;攴inus;抟lus;択imes;抠ȀLRlrᤙᤛᤝ᤟;敛;敘;攘;攔΀;HLRhlrᤰᤱᤳᤵᤷ᤻᤹攂;敪;敡;敞;攼;攤;攜Āevģ᥂bar耻¦䂦Ȁceioᥑᥖᥚᥠr;쀀𝒷mi;恏mĀ;e᜚᜜lƀ;bhᥨᥩᥫ䁜;槅sub;柈Ŭᥴ᥾lĀ;e᥹᥺怢t»᥺pƀ;Eeįᦅᦇ;檮Ā;qۜۛೡᦧ\0᧨ᨑᨕᨲ\0ᨷᩐ\0\0᪴\0\0᫁\0\0ᬡᬮ᭍᭒\0᯽\0ᰌƀcpr᦭ᦲ᧝ute;䄇̀;abcdsᦿᧀᧄ᧊᧕᧙戩nd;橄rcup;橉Āau᧏᧒p;橋p;橇ot;橀;쀀∩︀Āeo᧢᧥t;恁îړȀaeiu᧰᧻ᨁᨅǰ᧵\0᧸s;橍on;䄍dil耻ç䃧rc;䄉psĀ;sᨌᨍ橌m;橐ot;䄋ƀdmnᨛᨠᨦil肻¸ƭptyv;榲t脀¢;eᨭᨮ䂢räƲr;쀀𝔠ƀceiᨽᩀᩍy;䑇ckĀ;mᩇᩈ朓ark»ᩈ;䏇r΀;Ecefms᩟᩠ᩢᩫ᪤᪪᪮旋;槃ƀ;elᩩᩪᩭ䋆q;扗eɡᩴ\0\0᪈rrowĀlr᩼᪁eft;憺ight;憻ʀRSacd᪒᪔᪖᪚᪟»ཇ;擈st;抛irc;抚ash;抝nint;樐id;櫯cir;槂ubsĀ;u᪻᪼晣it»᪼ˬ᫇᫔᫺\0ᬊonĀ;eᫍᫎ䀺Ā;qÇÆɭ᫙\0\0᫢aĀ;t᫞᫟䀬;䁀ƀ;fl᫨᫩᫫戁îᅠeĀmx᫱᫶ent»᫩eóɍǧ᫾\0ᬇĀ;dኻᬂot;橭nôɆƀfryᬐᬔᬗ;쀀𝕔oäɔ脀©;sŕᬝr;愗Āaoᬥᬩrr;憵ss;朗Ācuᬲᬷr;쀀𝒸Ābpᬼ᭄Ā;eᭁᭂ櫏;櫑Ā;eᭉᭊ櫐;櫒dot;拯΀delprvw᭠᭬᭷ᮂᮬᯔ᯹arrĀlr᭨᭪;椸;椵ɰ᭲\0\0᭵r;拞c;拟arrĀ;p᭿ᮀ憶;椽̀;bcdosᮏᮐᮖᮡᮥᮨ截rcap;橈Āauᮛᮞp;橆p;橊ot;抍r;橅;쀀∪︀Ȁalrv᮵ᮿᯞᯣrrĀ;mᮼᮽ憷;椼yƀevwᯇᯔᯘqɰᯎ\0\0ᯒreã᭳uã᭵ee;拎edge;拏en耻¤䂤earrowĀlrᯮ᯳eft»ᮀight»ᮽeäᯝĀciᰁᰇoninôǷnt;戱lcty;挭ঀAHabcdefhijlorstuwz᰸᰻᰿ᱝᱩᱵᲊᲞᲬᲷ᳻᳿ᴍᵻᶑᶫᶻ᷆᷍rò΁ar;楥Ȁglrs᱈ᱍ᱒᱔ger;怠eth;愸òᄳhĀ;vᱚᱛ怐»ऊūᱡᱧarow;椏aã̕Āayᱮᱳron;䄏;䐴ƀ;ao̲ᱼᲄĀgrʿᲁr;懊tseq;橷ƀglmᲑᲔᲘ耻°䂰ta;䎴ptyv;榱ĀirᲣᲨsht;楿;쀀𝔡arĀlrᲳᲵ»ࣜ»သʀaegsv᳂͸᳖᳜᳠mƀ;oș᳊᳔ndĀ;ș᳑uit;晦amma;䏝in;拲ƀ;io᳧᳨᳸䃷de脀÷;o᳧ᳰntimes;拇nø᳷cy;䑒cɯᴆ\0\0ᴊrn;挞op;挍ʀlptuwᴘᴝᴢᵉᵕlar;䀤f;쀀𝕕ʀ;emps̋ᴭᴷᴽᵂqĀ;d͒ᴳot;扑inus;戸lus;戔quare;抡blebarwedgåúnƀadhᄮᵝᵧownarrowóᲃarpoonĀlrᵲᵶefôᲴighôᲶŢᵿᶅkaro÷གɯᶊ\0\0ᶎrn;挟op;挌ƀcotᶘᶣᶦĀryᶝᶡ;쀀𝒹;䑕l;槶rok;䄑Ādrᶰᶴot;拱iĀ;fᶺ᠖斿Āah᷀᷃ròЩaòྦangle;榦Āci᷒ᷕy;䑟grarr;柿ऀDacdefglmnopqrstuxḁḉḙḸոḼṉṡṾấắẽỡἪἷὄ὎὚ĀDoḆᴴoôᲉĀcsḎḔute耻é䃩ter;橮ȀaioyḢḧḱḶron;䄛rĀ;cḭḮ扖耻ê䃪lon;払;䑍ot;䄗ĀDrṁṅot;扒;쀀𝔢ƀ;rsṐṑṗ檚ave耻è䃨Ā;dṜṝ檖ot;檘Ȁ;ilsṪṫṲṴ檙nters;揧;愓Ā;dṹṺ檕ot;檗ƀapsẅẉẗcr;䄓tyƀ;svẒẓẕ戅et»ẓpĀ1;ẝẤĳạả;怄;怅怃ĀgsẪẬ;䅋p;怂ĀgpẴẸon;䄙f;쀀𝕖ƀalsỄỎỒrĀ;sỊị拕l;槣us;橱iƀ;lvỚớở䎵on»ớ;䏵ȀcsuvỪỳἋἣĀioữḱrc»Ḯɩỹ\0\0ỻíՈantĀglἂἆtr»ṝess»Ṻƀaeiἒ἖Ἒls;䀽st;扟vĀ;DȵἠD;橸parsl;槥ĀDaἯἳot;打rr;楱ƀcdiἾὁỸr;愯oô͒ĀahὉὋ;䎷耻ð䃰Āmrὓὗl耻ë䃫o;悬ƀcipὡὤὧl;䀡sôծĀeoὬὴctatioîՙnentialåչৡᾒ\0ᾞ\0ᾡᾧ\0\0ῆῌ\0ΐ\0ῦῪ \0 ⁚llingdotseñṄy;䑄male;晀ƀilrᾭᾳ῁lig;耀ﬃɩᾹ\0\0᾽g;耀ﬀig;耀ﬄ;쀀𝔣lig;耀ﬁlig;쀀fjƀaltῙ῜ῡt;晭ig;耀ﬂns;斱of;䆒ǰ΅\0ῳf;쀀𝕗ĀakֿῷĀ;vῼ´拔;櫙artint;樍Āao‌⁕Ācs‑⁒α‚‰‸⁅⁈\0⁐β•‥‧‪‬\0‮耻½䂽;慓耻¼䂼;慕;慙;慛Ƴ‴\0‶;慔;慖ʴ‾⁁\0\0⁃耻¾䂾;慗;慜5;慘ƶ⁌\0⁎;慚;慝8;慞l;恄wn;挢cr;쀀𝒻ࢀEabcdefgijlnorstv₂₉₟₥₰₴⃰⃵⃺⃿℃ℒℸ̗ℾ⅒↞Ā;lٍ₇;檌ƀcmpₐₕ₝ute;䇵maĀ;dₜ᳚䎳;檆reve;䄟Āiy₪₮rc;䄝;䐳ot;䄡Ȁ;lqsؾق₽⃉ƀ;qsؾٌ⃄lanô٥Ȁ;cdl٥⃒⃥⃕c;檩otĀ;o⃜⃝檀Ā;l⃢⃣檂;檄Ā;e⃪⃭쀀⋛︀s;檔r;쀀𝔤Ā;gٳ؛mel;愷cy;䑓Ȁ;Eajٚℌℎℐ;檒;檥;檤ȀEaesℛℝ℩ℴ;扩pĀ;p℣ℤ檊rox»ℤĀ;q℮ℯ檈Ā;q℮ℛim;拧pf;쀀𝕘Āci⅃ⅆr;愊mƀ;el٫ⅎ⅐;檎;檐茀>;cdlqr׮ⅠⅪⅮⅳⅹĀciⅥⅧ;檧r;橺ot;拗Par;榕uest;橼ʀadelsↄⅪ←ٖ↛ǰ↉\0↎proø₞r;楸qĀlqؿ↖lesó₈ií٫Āen↣↭rtneqq;쀀≩︀Å↪ԀAabcefkosy⇄⇇⇱⇵⇺∘∝∯≨≽ròΠȀilmr⇐⇔⇗⇛rsðᒄf»․ilôکĀdr⇠⇤cy;䑊ƀ;cwࣴ⇫⇯ir;楈;憭ar;意irc;䄥ƀalr∁∎∓rtsĀ;u∉∊晥it»∊lip;怦con;抹r;쀀𝔥sĀew∣∩arow;椥arow;椦ʀamopr∺∾≃≞≣rr;懿tht;戻kĀlr≉≓eftarrow;憩ightarrow;憪f;쀀𝕙bar;怕ƀclt≯≴≸r;쀀𝒽asè⇴rok;䄧Ābp⊂⊇ull;恃hen»ᱛૡ⊣\0⊪\0⊸⋅⋎\0⋕⋳\0\0⋸⌢⍧⍢⍿\0⎆⎪⎴cute耻í䃭ƀ;iyݱ⊰⊵rc耻î䃮;䐸Ācx⊼⊿y;䐵cl耻¡䂡ĀfrΟ⋉;쀀𝔦rave耻ì䃬Ȁ;inoܾ⋝⋩⋮Āin⋢⋦nt;樌t;戭fin;槜ta;愩lig;䄳ƀaop⋾⌚⌝ƀcgt⌅⌈⌗r;䄫ƀelpܟ⌏⌓inåގarôܠh;䄱f;抷ed;䆵ʀ;cfotӴ⌬⌱⌽⍁are;愅inĀ;t⌸⌹戞ie;槝doô⌙ʀ;celpݗ⍌⍐⍛⍡al;抺Āgr⍕⍙eróᕣã⍍arhk;樗rod;樼Ȁcgpt⍯⍲⍶⍻y;䑑on;䄯f;쀀𝕚a;䎹uest耻¿䂿Āci⎊⎏r;쀀𝒾nʀ;EdsvӴ⎛⎝⎡ӳ;拹ot;拵Ā;v⎦⎧拴;拳Ā;iݷ⎮lde;䄩ǫ⎸\0⎼cy;䑖l耻ï䃯̀cfmosu⏌⏗⏜⏡⏧⏵Āiy⏑⏕rc;䄵;䐹r;쀀𝔧ath;䈷pf;쀀𝕛ǣ⏬\0⏱r;쀀𝒿rcy;䑘kcy;䑔Ѐacfghjos␋␖␢␧␭␱␵␻ppaĀ;v␓␔䎺;䏰Āey␛␠dil;䄷;䐺r;쀀𝔨reen;䄸cy;䑅cy;䑜pf;쀀𝕜cr;쀀𝓀஀ABEHabcdefghjlmnoprstuv⑰⒁⒆⒍⒑┎┽╚▀♎♞♥♹♽⚚⚲⛘❝❨➋⟀⠁⠒ƀart⑷⑺⑼rò৆òΕail;椛arr;椎Ā;gঔ⒋;檋ar;楢ॣ⒥\0⒪\0⒱\0\0\0\0\0⒵Ⓔ\0ⓆⓈⓍ\0⓹ute;䄺mptyv;榴raîࡌbda;䎻gƀ;dlࢎⓁⓃ;榑åࢎ;檅uo耻«䂫rЀ;bfhlpst࢙ⓞⓦⓩ⓫⓮⓱⓵Ā;f࢝ⓣs;椟s;椝ë≒p;憫l;椹im;楳l;憢ƀ;ae⓿─┄檫il;椙Ā;s┉┊檭;쀀⪭︀ƀabr┕┙┝rr;椌rk;杲Āak┢┬cĀek┨┪;䁻;䁛Āes┱┳;榋lĀdu┹┻;榏;榍Ȁaeuy╆╋╖╘ron;䄾Ādi═╔il;䄼ìࢰâ┩;䐻Ȁcqrs╣╦╭╽a;椶uoĀ;rนᝆĀdu╲╷har;楧shar;楋h;憲ʀ;fgqs▋▌উ◳◿扤tʀahlrt▘▤▷◂◨rrowĀ;t࢙□aé⓶arpoonĀdu▯▴own»њp»०eftarrows;懇ightƀahs◍◖◞rrowĀ;sࣴࢧarpoonó྘quigarro÷⇰hreetimes;拋ƀ;qs▋ও◺lanôবʀ;cdgsব☊☍☝☨c;檨otĀ;o☔☕橿Ā;r☚☛檁;檃Ā;e☢☥쀀⋚︀s;檓ʀadegs☳☹☽♉♋pproøⓆot;拖qĀgq♃♅ôউgtò⒌ôছiíলƀilr♕࣡♚sht;楼;쀀𝔩Ā;Eজ♣;檑š♩♶rĀdu▲♮Ā;l॥♳;楪lk;斄cy;䑙ʀ;achtੈ⚈⚋⚑⚖rò◁orneòᴈard;楫ri;旺Āio⚟⚤dot;䅀ustĀ;a⚬⚭掰che»⚭ȀEaes⚻⚽⛉⛔;扨pĀ;p⛃⛄檉rox»⛄Ā;q⛎⛏檇Ā;q⛎⚻im;拦Ѐabnoptwz⛩⛴⛷✚✯❁❇❐Ānr⛮⛱g;柬r;懽rëࣁgƀlmr⛿✍✔eftĀar০✇ightá৲apsto;柼ightá৽parrowĀlr✥✩efô⓭ight;憬ƀafl✶✹✽r;榅;쀀𝕝us;樭imes;樴š❋❏st;戗áፎƀ;ef❗❘᠀旊nge»❘arĀ;l❤❥䀨t;榓ʀachmt❳❶❼➅➇ròࢨorneòᶌarĀ;d྘➃;業;怎ri;抿̀achiqt➘➝ੀ➢➮➻quo;怹r;쀀𝓁mƀ;egল➪➬;檍;檏Ābu┪➳oĀ;rฟ➹;怚rok;䅂萀<;cdhilqrࠫ⟒☹⟜⟠⟥⟪⟰Āci⟗⟙;檦r;橹reå◲mes;拉arr;楶uest;橻ĀPi⟵⟹ar;榖ƀ;ef⠀भ᠛旃rĀdu⠇⠍shar;楊har;楦Āen⠗⠡rtneqq;쀀≨︀Å⠞܀Dacdefhilnopsu⡀⡅⢂⢎⢓⢠⢥⢨⣚⣢⣤ઃ⣳⤂Dot;戺Ȁclpr⡎⡒⡣⡽r耻¯䂯Āet⡗⡙;時Ā;e⡞⡟朠se»⡟Ā;sျ⡨toȀ;dluျ⡳⡷⡻owîҌefôएðᏑker;斮Āoy⢇⢌mma;権;䐼ash;怔asuredangle»ᘦr;쀀𝔪o;愧ƀcdn⢯⢴⣉ro耻µ䂵Ȁ;acdᑤ⢽⣀⣄sôᚧir;櫰ot肻·Ƶusƀ;bd⣒ᤃ⣓戒Ā;uᴼ⣘;横ţ⣞⣡p;櫛ò−ðઁĀdp⣩⣮els;抧f;쀀𝕞Āct⣸⣽r;쀀𝓂pos»ᖝƀ;lm⤉⤊⤍䎼timap;抸ఀGLRVabcdefghijlmoprstuvw⥂⥓⥾⦉⦘⧚⧩⨕⨚⩘⩝⪃⪕⪤⪨⬄⬇⭄⭿⮮ⰴⱧⱼ⳩Āgt⥇⥋;쀀⋙̸Ā;v⥐௏쀀≫⃒ƀelt⥚⥲⥶ftĀar⥡⥧rrow;懍ightarrow;懎;쀀⋘̸Ā;v⥻ే쀀≪⃒ightarrow;懏ĀDd⦎⦓ash;抯ash;抮ʀbcnpt⦣⦧⦬⦱⧌la»˞ute;䅄g;쀀∠⃒ʀ;Eiop඄⦼⧀⧅⧈;쀀⩰̸d;쀀≋̸s;䅉roø඄urĀ;a⧓⧔普lĀ;s⧓ସǳ⧟\0⧣p肻 ଷmpĀ;e௹ఀʀaeouy⧴⧾⨃⨐⨓ǰ⧹\0⧻;橃on;䅈dil;䅆ngĀ;dൾ⨊ot;쀀⩭̸p;橂;䐽ash;怓΀;Aadqsxஒ⨩⨭⨻⩁⩅⩐rr;懗rĀhr⨳⨶k;椤Ā;oᏲᏰot;쀀≐̸uiöୣĀei⩊⩎ar;椨í஘istĀ;s஠டr;쀀𝔫ȀEest௅⩦⩹⩼ƀ;qs஼⩭௡ƀ;qs஼௅⩴lanô௢ií௪Ā;rஶ⪁»ஷƀAap⪊⪍⪑rò⥱rr;憮ar;櫲ƀ;svྍ⪜ྌĀ;d⪡⪢拼;拺cy;䑚΀AEadest⪷⪺⪾⫂⫅⫶⫹rò⥦;쀀≦̸rr;憚r;急Ȁ;fqs఻⫎⫣⫯tĀar⫔⫙rro÷⫁ightarro÷⪐ƀ;qs఻⪺⫪lanôౕĀ;sౕ⫴»శiíౝĀ;rవ⫾iĀ;eచథiäඐĀpt⬌⬑f;쀀𝕟膀¬;in⬙⬚⬶䂬nȀ;Edvஉ⬤⬨⬮;쀀⋹̸ot;쀀⋵̸ǡஉ⬳⬵;拷;拶iĀ;vಸ⬼ǡಸ⭁⭃;拾;拽ƀaor⭋⭣⭩rȀ;ast୻⭕⭚⭟lleì୻l;쀀⫽⃥;쀀∂̸lint;樔ƀ;ceಒ⭰⭳uåಥĀ;cಘ⭸Ā;eಒ⭽ñಘȀAait⮈⮋⮝⮧rò⦈rrƀ;cw⮔⮕⮙憛;쀀⤳̸;쀀↝̸ghtarrow»⮕riĀ;eೋೖ΀chimpqu⮽⯍⯙⬄୸⯤⯯Ȁ;cerല⯆ഷ⯉uå൅;쀀𝓃ortɭ⬅\0\0⯖ará⭖mĀ;e൮⯟Ā;q൴൳suĀbp⯫⯭å೸åഋƀbcp⯶ⰑⰙȀ;Ees⯿ⰀഢⰄ抄;쀀⫅̸etĀ;eഛⰋqĀ;qണⰀcĀ;eലⰗñസȀ;EesⰢⰣൟⰧ抅;쀀⫆̸etĀ;e൘ⰮqĀ;qൠⰣȀgilrⰽⰿⱅⱇìௗlde耻ñ䃱çృiangleĀlrⱒⱜeftĀ;eచⱚñదightĀ;eೋⱥñ೗Ā;mⱬⱭ䎽ƀ;esⱴⱵⱹ䀣ro;愖p;怇ҀDHadgilrsⲏⲔⲙⲞⲣⲰⲶⳓⳣash;抭arr;椄p;쀀≍⃒ash;抬ĀetⲨⲬ;쀀≥⃒;쀀>⃒nfin;槞ƀAetⲽⳁⳅrr;椂;쀀≤⃒Ā;rⳊⳍ쀀<⃒ie;쀀⊴⃒ĀAtⳘⳜrr;椃rie;쀀⊵⃒im;쀀∼⃒ƀAan⳰⳴ⴂrr;懖rĀhr⳺⳽k;椣Ā;oᏧᏥear;椧ቓ᪕\0\0\0\0\0\0\0\0\0\0\0\0\0ⴭ\0ⴸⵈⵠⵥ⵲ⶄᬇ\0\0ⶍⶫ\0ⷈⷎ\0ⷜ⸙⸫⸾⹃Ācsⴱ᪗ute耻ó䃳ĀiyⴼⵅrĀ;c᪞ⵂ耻ô䃴;䐾ʀabios᪠ⵒⵗǈⵚlac;䅑v;樸old;榼lig;䅓Ācr⵩⵭ir;榿;쀀𝔬ͯ⵹\0\0⵼\0ⶂn;䋛ave耻ò䃲;槁Ābmⶈ෴ar;榵Ȁacitⶕ⶘ⶥⶨrò᪀Āir⶝ⶠr;榾oss;榻nå๒;槀ƀaeiⶱⶵⶹcr;䅍ga;䏉ƀcdnⷀⷅǍron;䎿;榶pf;쀀𝕠ƀaelⷔ⷗ǒr;榷rp;榹΀;adiosvⷪⷫⷮ⸈⸍⸐⸖戨rò᪆Ȁ;efmⷷⷸ⸂⸅橝rĀ;oⷾⷿ愴f»ⷿ耻ª䂪耻º䂺gof;抶r;橖lope;橗;橛ƀclo⸟⸡⸧ò⸁ash耻ø䃸l;折iŬⸯ⸴de耻õ䃵esĀ;aǛ⸺s;樶ml耻ö䃶bar;挽ૡ⹞\0⹽\0⺀⺝\0⺢⺹\0\0⻋ຜ\0⼓\0\0⼫⾼\0⿈rȀ;astЃ⹧⹲຅脀¶;l⹭⹮䂶leìЃɩ⹸\0\0⹻m;櫳;櫽y;䐿rʀcimpt⺋⺏⺓ᡥ⺗nt;䀥od;䀮il;怰enk;怱r;쀀𝔭ƀimo⺨⺰⺴Ā;v⺭⺮䏆;䏕maô੶ne;明ƀ;tv⺿⻀⻈䏀chfork»´;䏖Āau⻏⻟nĀck⻕⻝kĀ;h⇴⻛;愎ö⇴sҀ;abcdemst⻳⻴ᤈ⻹⻽⼄⼆⼊⼎䀫cir;樣ir;樢Āouᵀ⼂;樥;橲n肻±ຝim;樦wo;樧ƀipu⼙⼠⼥ntint;樕f;쀀𝕡nd耻£䂣Ԁ;Eaceinosu່⼿⽁⽄⽇⾁⾉⾒⽾⾶;檳p;檷uå໙Ā;c໎⽌̀;acens່⽙⽟⽦⽨⽾pproø⽃urlyeñ໙ñ໎ƀaes⽯⽶⽺pprox;檹qq;檵im;拨iíໟmeĀ;s⾈ຮ怲ƀEas⽸⾐⽺ð⽵ƀdfp໬⾙⾯ƀals⾠⾥⾪lar;挮ine;挒urf;挓Ā;t໻⾴ï໻rel;抰Āci⿀⿅r;쀀𝓅;䏈ncsp;怈̀fiopsu⿚⋢⿟⿥⿫⿱r;쀀𝔮pf;쀀𝕢rime;恗cr;쀀𝓆ƀaeo⿸〉〓tĀei⿾々rnionóڰnt;樖stĀ;e【】䀿ñἙô༔઀ABHabcdefhilmnoprstux぀けさすムㄎㄫㅇㅢㅲㆎ㈆㈕㈤㈩㉘㉮㉲㊐㊰㊷ƀartぇおがròႳòϝail;検aròᱥar;楤΀cdenqrtとふへみわゔヌĀeuねぱ;쀀∽̱te;䅕iãᅮmptyv;榳gȀ;del࿑らるろ;榒;榥å࿑uo耻»䂻rր;abcfhlpstw࿜ガクシスゼゾダッデナp;極Ā;f࿠ゴs;椠;椳s;椞ë≝ð✮l;楅im;楴l;憣;憝Āaiパフil;椚oĀ;nホボ戶aló༞ƀabrョリヮrò៥rk;杳ĀakンヽcĀekヹ・;䁽;䁝Āes㄂㄄;榌lĀduㄊㄌ;榎;榐Ȁaeuyㄗㄜㄧㄩron;䅙Ādiㄡㄥil;䅗ì࿲âヺ;䑀Ȁclqsㄴㄷㄽㅄa;椷dhar;楩uoĀ;rȎȍh;憳ƀacgㅎㅟངlȀ;ipsླྀㅘㅛႜnåႻarôྩt;断ƀilrㅩဣㅮsht;楽;쀀𝔯ĀaoㅷㆆrĀduㅽㅿ»ѻĀ;l႑ㆄ;楬Ā;vㆋㆌ䏁;䏱ƀgns㆕ㇹㇼht̀ahlrstㆤㆰ㇂㇘㇤㇮rrowĀ;t࿜ㆭaéトarpoonĀduㆻㆿowîㅾp»႒eftĀah㇊㇐rrowó࿪arpoonóՑightarrows;應quigarro÷ニhreetimes;拌g;䋚ingdotseñἲƀahm㈍㈐㈓rò࿪aòՑ;怏oustĀ;a㈞㈟掱che»㈟mid;櫮Ȁabpt㈲㈽㉀㉒Ānr㈷㈺g;柭r;懾rëဃƀafl㉇㉊㉎r;榆;쀀𝕣us;樮imes;樵Āap㉝㉧rĀ;g㉣㉤䀩t;榔olint;樒arò㇣Ȁachq㉻㊀Ⴜ㊅quo;怺r;쀀𝓇Ābu・㊊oĀ;rȔȓƀhir㊗㊛㊠reåㇸmes;拊iȀ;efl㊪ၙᠡ㊫方tri;槎luhar;楨;愞ൡ㋕㋛㋟㌬㌸㍱\0㍺㎤\0\0㏬㏰\0㐨㑈㑚㒭㒱㓊㓱\0㘖\0\0㘳cute;䅛quï➺Ԁ;Eaceinpsyᇭ㋳㋵㋿㌂㌋㌏㌟㌦㌩;檴ǰ㋺\0㋼;檸on;䅡uåᇾĀ;dᇳ㌇il;䅟rc;䅝ƀEas㌖㌘㌛;檶p;檺im;择olint;樓iíሄ;䑁otƀ;be㌴ᵇ㌵担;橦΀Aacmstx㍆㍊㍗㍛㍞㍣㍭rr;懘rĀhr㍐㍒ë∨Ā;oਸ਼਴t耻§䂧i;䀻war;椩mĀin㍩ðnuóñt;朶rĀ;o㍶⁕쀀𝔰Ȁacoy㎂㎆㎑㎠rp;景Āhy㎋㎏cy;䑉;䑈rtɭ㎙\0\0㎜iäᑤaraì⹯耻­䂭Āgm㎨㎴maƀ;fv㎱㎲㎲䏃;䏂Ѐ;deglnprካ㏅㏉㏎㏖㏞㏡㏦ot;橪Ā;q኱ኰĀ;E㏓㏔檞;檠Ā;E㏛㏜檝;檟e;扆lus;樤arr;楲aròᄽȀaeit㏸㐈㐏㐗Āls㏽㐄lsetmé㍪hp;樳parsl;槤Ādlᑣ㐔e;挣Ā;e㐜㐝檪Ā;s㐢㐣檬;쀀⪬︀ƀflp㐮㐳㑂tcy;䑌Ā;b㐸㐹䀯Ā;a㐾㐿槄r;挿f;쀀𝕤aĀdr㑍ЂesĀ;u㑔㑕晠it»㑕ƀcsu㑠㑹㒟Āau㑥㑯pĀ;sᆈ㑫;쀀⊓︀pĀ;sᆴ㑵;쀀⊔︀uĀbp㑿㒏ƀ;esᆗᆜ㒆etĀ;eᆗ㒍ñᆝƀ;esᆨᆭ㒖etĀ;eᆨ㒝ñᆮƀ;afᅻ㒦ְrť㒫ֱ»ᅼaròᅈȀcemt㒹㒾㓂㓅r;쀀𝓈tmîñiì㐕aræᆾĀar㓎㓕rĀ;f㓔ឿ昆Āan㓚㓭ightĀep㓣㓪psiloîỠhé⺯s»⡒ʀbcmnp㓻㕞ሉ㖋㖎Ҁ;Edemnprs㔎㔏㔑㔕㔞㔣㔬㔱㔶抂;櫅ot;檽Ā;dᇚ㔚ot;櫃ult;櫁ĀEe㔨㔪;櫋;把lus;檿arr;楹ƀeiu㔽㕒㕕tƀ;en㔎㕅㕋qĀ;qᇚ㔏eqĀ;q㔫㔨m;櫇Ābp㕚㕜;櫕;櫓c̀;acensᇭ㕬㕲㕹㕻㌦pproø㋺urlyeñᇾñᇳƀaes㖂㖈㌛pproø㌚qñ㌗g;晪ڀ123;Edehlmnps㖩㖬㖯ሜ㖲㖴㗀㗉㗕㗚㗟㗨㗭耻¹䂹耻²䂲耻³䂳;櫆Āos㖹㖼t;檾ub;櫘Ā;dሢ㗅ot;櫄sĀou㗏㗒l;柉b;櫗arr;楻ult;櫂ĀEe㗤㗦;櫌;抋lus;櫀ƀeiu㗴㘉㘌tƀ;enሜ㗼㘂qĀ;qሢ㖲eqĀ;q㗧㗤m;櫈Ābp㘑㘓;櫔;櫖ƀAan㘜㘠㘭rr;懙rĀhr㘦㘨ë∮Ā;oਫ਩war;椪lig耻ß䃟௡㙑㙝㙠ዎ㙳㙹\0㙾㛂\0\0\0\0\0㛛㜃\0㜉㝬\0\0\0㞇ɲ㙖\0\0㙛get;挖;䏄rë๟ƀaey㙦㙫㙰ron;䅥dil;䅣;䑂lrec;挕r;쀀𝔱Ȁeiko㚆㚝㚵㚼ǲ㚋\0㚑eĀ4fኄኁaƀ;sv㚘㚙㚛䎸ym;䏑Ācn㚢㚲kĀas㚨㚮pproø዁im»ኬsðኞĀas㚺㚮ð዁rn耻þ䃾Ǭ̟㛆⋧es膀×;bd㛏㛐㛘䃗Ā;aᤏ㛕r;樱;樰ƀeps㛡㛣㜀á⩍Ȁ;bcf҆㛬㛰㛴ot;挶ir;櫱Ā;o㛹㛼쀀𝕥rk;櫚á㍢rime;怴ƀaip㜏㜒㝤dåቈ΀adempst㜡㝍㝀㝑㝗㝜㝟ngleʀ;dlqr㜰㜱㜶㝀㝂斵own»ᶻeftĀ;e⠀㜾ñम;扜ightĀ;e㊪㝋ñၚot;旬inus;樺lus;樹b;槍ime;樻ezium;揢ƀcht㝲㝽㞁Āry㝷㝻;쀀𝓉;䑆cy;䑛rok;䅧Āio㞋㞎xô᝷headĀlr㞗㞠eftarro÷ࡏightarrow»ཝऀAHabcdfghlmoprstuw㟐㟓㟗㟤㟰㟼㠎㠜㠣㠴㡑㡝㡫㢩㣌㣒㣪㣶ròϭar;楣Ācr㟜㟢ute耻ú䃺òᅐrǣ㟪\0㟭y;䑞ve;䅭Āiy㟵㟺rc耻û䃻;䑃ƀabh㠃㠆㠋ròᎭlac;䅱aòᏃĀir㠓㠘sht;楾;쀀𝔲rave耻ù䃹š㠧㠱rĀlr㠬㠮»ॗ»ႃlk;斀Āct㠹㡍ɯ㠿\0\0㡊rnĀ;e㡅㡆挜r»㡆op;挏ri;旸Āal㡖㡚cr;䅫肻¨͉Āgp㡢㡦on;䅳f;쀀𝕦̀adhlsuᅋ㡸㡽፲㢑㢠ownáᎳarpoonĀlr㢈㢌efô㠭ighô㠯iƀ;hl㢙㢚㢜䏅»ᏺon»㢚parrows;懈ƀcit㢰㣄㣈ɯ㢶\0\0㣁rnĀ;e㢼㢽挝r»㢽op;挎ng;䅯ri;旹cr;쀀𝓊ƀdir㣙㣝㣢ot;拰lde;䅩iĀ;f㜰㣨»᠓Āam㣯㣲rò㢨l耻ü䃼angle;榧ހABDacdeflnoprsz㤜㤟㤩㤭㦵㦸㦽㧟㧤㧨㧳㧹㧽㨁㨠ròϷarĀ;v㤦㤧櫨;櫩asèϡĀnr㤲㤷grt;榜΀eknprst㓣㥆㥋㥒㥝㥤㦖appá␕othinçẖƀhir㓫⻈㥙opô⾵Ā;hᎷ㥢ïㆍĀiu㥩㥭gmá㎳Ābp㥲㦄setneqĀ;q㥽㦀쀀⊊︀;쀀⫋︀setneqĀ;q㦏㦒쀀⊋︀;쀀⫌︀Āhr㦛㦟etá㚜iangleĀlr㦪㦯eft»थight»ၑy;䐲ash»ံƀelr㧄㧒㧗ƀ;beⷪ㧋㧏ar;抻q;扚lip;拮Ābt㧜ᑨaòᑩr;쀀𝔳tré㦮suĀbp㧯㧱»ജ»൙pf;쀀𝕧roð໻tré㦴Ācu㨆㨋r;쀀𝓋Ābp㨐㨘nĀEe㦀㨖»㥾nĀEe㦒㨞»㦐igzag;榚΀cefoprs㨶㨻㩖㩛㩔㩡㩪irc;䅵Ādi㩀㩑Ābg㩅㩉ar;機eĀ;qᗺ㩏;扙erp;愘r;쀀𝔴pf;쀀𝕨Ā;eᑹ㩦atèᑹcr;쀀𝓌ૣណ㪇\0㪋\0㪐㪛\0\0㪝㪨㪫㪯\0\0㫃㫎\0㫘ៜ៟tré៑r;쀀𝔵ĀAa㪔㪗ròσrò৶;䎾ĀAa㪡㪤ròθrò৫að✓is;拻ƀdptឤ㪵㪾Āfl㪺ឩ;쀀𝕩imåឲĀAa㫇㫊ròώròਁĀcq㫒ីr;쀀𝓍Āpt៖㫜ré។Ѐacefiosu㫰㫽㬈㬌㬑㬕㬛㬡cĀuy㫶㫻te耻ý䃽;䑏Āiy㬂㬆rc;䅷;䑋n耻¥䂥r;쀀𝔶cy;䑗pf;쀀𝕪cr;쀀𝓎Ācm㬦㬩y;䑎l耻ÿ䃿Ԁacdefhiosw㭂㭈㭔㭘㭤㭩㭭㭴㭺㮀cute;䅺Āay㭍㭒ron;䅾;䐷ot;䅼Āet㭝㭡træᕟa;䎶r;쀀𝔷cy;䐶grarr;懝pf;쀀𝕫cr;쀀𝓏Ājn㮅㮇;怍j;怌'.split("").map((c) => c.charCodeAt(0))
  );
  const xmlDecodeTree = new Uint16Array(
"Ȁaglq	\x1Bɭ\0\0p;䀦os;䀧t;䀾t;䀼uot;䀢".split("").map((c) => c.charCodeAt(0))
  );
  var _a;
  const decodeMap = new Map([
    [0, 65533],
[128, 8364],
    [130, 8218],
    [131, 402],
    [132, 8222],
    [133, 8230],
    [134, 8224],
    [135, 8225],
    [136, 710],
    [137, 8240],
    [138, 352],
    [139, 8249],
    [140, 338],
    [142, 381],
    [145, 8216],
    [146, 8217],
    [147, 8220],
    [148, 8221],
    [149, 8226],
    [150, 8211],
    [151, 8212],
    [152, 732],
    [153, 8482],
    [154, 353],
    [155, 8250],
    [156, 339],
    [158, 382],
    [159, 376]
  ]);
  const fromCodePoint$1 = (
(_a = String.fromCodePoint) !== null && _a !== void 0 ? _a : function(codePoint) {
      let output = "";
      if (codePoint > 65535) {
        codePoint -= 65536;
        output += String.fromCharCode(codePoint >>> 10 & 1023 | 55296);
        codePoint = 56320 | codePoint & 1023;
      }
      output += String.fromCharCode(codePoint);
      return output;
    }
  );
  function replaceCodePoint(codePoint) {
    var _a2;
    if (codePoint >= 55296 && codePoint <= 57343 || codePoint > 1114111) {
      return 65533;
    }
    return (_a2 = decodeMap.get(codePoint)) !== null && _a2 !== void 0 ? _a2 : codePoint;
  }
  var CharCodes;
  (function(CharCodes2) {
    CharCodes2[CharCodes2["NUM"] = 35] = "NUM";
    CharCodes2[CharCodes2["SEMI"] = 59] = "SEMI";
    CharCodes2[CharCodes2["EQUALS"] = 61] = "EQUALS";
    CharCodes2[CharCodes2["ZERO"] = 48] = "ZERO";
    CharCodes2[CharCodes2["NINE"] = 57] = "NINE";
    CharCodes2[CharCodes2["LOWER_A"] = 97] = "LOWER_A";
    CharCodes2[CharCodes2["LOWER_F"] = 102] = "LOWER_F";
    CharCodes2[CharCodes2["LOWER_X"] = 120] = "LOWER_X";
    CharCodes2[CharCodes2["LOWER_Z"] = 122] = "LOWER_Z";
    CharCodes2[CharCodes2["UPPER_A"] = 65] = "UPPER_A";
    CharCodes2[CharCodes2["UPPER_F"] = 70] = "UPPER_F";
    CharCodes2[CharCodes2["UPPER_Z"] = 90] = "UPPER_Z";
  })(CharCodes || (CharCodes = {}));
  const TO_LOWER_BIT = 32;
  var BinTrieFlags;
  (function(BinTrieFlags2) {
    BinTrieFlags2[BinTrieFlags2["VALUE_LENGTH"] = 49152] = "VALUE_LENGTH";
    BinTrieFlags2[BinTrieFlags2["BRANCH_LENGTH"] = 16256] = "BRANCH_LENGTH";
    BinTrieFlags2[BinTrieFlags2["JUMP_TABLE"] = 127] = "JUMP_TABLE";
  })(BinTrieFlags || (BinTrieFlags = {}));
  function isNumber(code2) {
    return code2 >= CharCodes.ZERO && code2 <= CharCodes.NINE;
  }
  function isHexadecimalCharacter(code2) {
    return code2 >= CharCodes.UPPER_A && code2 <= CharCodes.UPPER_F || code2 >= CharCodes.LOWER_A && code2 <= CharCodes.LOWER_F;
  }
  function isAsciiAlphaNumeric(code2) {
    return code2 >= CharCodes.UPPER_A && code2 <= CharCodes.UPPER_Z || code2 >= CharCodes.LOWER_A && code2 <= CharCodes.LOWER_Z || isNumber(code2);
  }
  function isEntityInAttributeInvalidEnd(code2) {
    return code2 === CharCodes.EQUALS || isAsciiAlphaNumeric(code2);
  }
  var EntityDecoderState;
  (function(EntityDecoderState2) {
    EntityDecoderState2[EntityDecoderState2["EntityStart"] = 0] = "EntityStart";
    EntityDecoderState2[EntityDecoderState2["NumericStart"] = 1] = "NumericStart";
    EntityDecoderState2[EntityDecoderState2["NumericDecimal"] = 2] = "NumericDecimal";
    EntityDecoderState2[EntityDecoderState2["NumericHex"] = 3] = "NumericHex";
    EntityDecoderState2[EntityDecoderState2["NamedEntity"] = 4] = "NamedEntity";
  })(EntityDecoderState || (EntityDecoderState = {}));
  var DecodingMode;
  (function(DecodingMode2) {
    DecodingMode2[DecodingMode2["Legacy"] = 0] = "Legacy";
    DecodingMode2[DecodingMode2["Strict"] = 1] = "Strict";
    DecodingMode2[DecodingMode2["Attribute"] = 2] = "Attribute";
  })(DecodingMode || (DecodingMode = {}));
  class EntityDecoder {
    constructor(decodeTree, emitCodePoint, errors2) {
      this.decodeTree = decodeTree;
      this.emitCodePoint = emitCodePoint;
      this.errors = errors2;
      this.state = EntityDecoderState.EntityStart;
      this.consumed = 1;
      this.result = 0;
      this.treeIndex = 0;
      this.excess = 1;
      this.decodeMode = DecodingMode.Strict;
    }
startEntity(decodeMode) {
      this.decodeMode = decodeMode;
      this.state = EntityDecoderState.EntityStart;
      this.result = 0;
      this.treeIndex = 0;
      this.excess = 1;
      this.consumed = 1;
    }
write(str, offset) {
      switch (this.state) {
        case EntityDecoderState.EntityStart: {
          if (str.charCodeAt(offset) === CharCodes.NUM) {
            this.state = EntityDecoderState.NumericStart;
            this.consumed += 1;
            return this.stateNumericStart(str, offset + 1);
          }
          this.state = EntityDecoderState.NamedEntity;
          return this.stateNamedEntity(str, offset);
        }
        case EntityDecoderState.NumericStart: {
          return this.stateNumericStart(str, offset);
        }
        case EntityDecoderState.NumericDecimal: {
          return this.stateNumericDecimal(str, offset);
        }
        case EntityDecoderState.NumericHex: {
          return this.stateNumericHex(str, offset);
        }
        case EntityDecoderState.NamedEntity: {
          return this.stateNamedEntity(str, offset);
        }
      }
    }
stateNumericStart(str, offset) {
      if (offset >= str.length) {
        return -1;
      }
      if ((str.charCodeAt(offset) | TO_LOWER_BIT) === CharCodes.LOWER_X) {
        this.state = EntityDecoderState.NumericHex;
        this.consumed += 1;
        return this.stateNumericHex(str, offset + 1);
      }
      this.state = EntityDecoderState.NumericDecimal;
      return this.stateNumericDecimal(str, offset);
    }
    addToNumericResult(str, start, end, base2) {
      if (start !== end) {
        const digitCount = end - start;
        this.result = this.result * Math.pow(base2, digitCount) + parseInt(str.substr(start, digitCount), base2);
        this.consumed += digitCount;
      }
    }
stateNumericHex(str, offset) {
      const startIdx = offset;
      while (offset < str.length) {
        const char = str.charCodeAt(offset);
        if (isNumber(char) || isHexadecimalCharacter(char)) {
          offset += 1;
        } else {
          this.addToNumericResult(str, startIdx, offset, 16);
          return this.emitNumericEntity(char, 3);
        }
      }
      this.addToNumericResult(str, startIdx, offset, 16);
      return -1;
    }
stateNumericDecimal(str, offset) {
      const startIdx = offset;
      while (offset < str.length) {
        const char = str.charCodeAt(offset);
        if (isNumber(char)) {
          offset += 1;
        } else {
          this.addToNumericResult(str, startIdx, offset, 10);
          return this.emitNumericEntity(char, 2);
        }
      }
      this.addToNumericResult(str, startIdx, offset, 10);
      return -1;
    }
emitNumericEntity(lastCp, expectedLength) {
      var _a2;
      if (this.consumed <= expectedLength) {
        (_a2 = this.errors) === null || _a2 === void 0 ? void 0 : _a2.absenceOfDigitsInNumericCharacterReference(this.consumed);
        return 0;
      }
      if (lastCp === CharCodes.SEMI) {
        this.consumed += 1;
      } else if (this.decodeMode === DecodingMode.Strict) {
        return 0;
      }
      this.emitCodePoint(replaceCodePoint(this.result), this.consumed);
      if (this.errors) {
        if (lastCp !== CharCodes.SEMI) {
          this.errors.missingSemicolonAfterCharacterReference();
        }
        this.errors.validateNumericCharacterReference(this.result);
      }
      return this.consumed;
    }
stateNamedEntity(str, offset) {
      const { decodeTree } = this;
      let current = decodeTree[this.treeIndex];
      let valueLength = (current & BinTrieFlags.VALUE_LENGTH) >> 14;
      for (; offset < str.length; offset++, this.excess++) {
        const char = str.charCodeAt(offset);
        this.treeIndex = determineBranch(decodeTree, current, this.treeIndex + Math.max(1, valueLength), char);
        if (this.treeIndex < 0) {
          return this.result === 0 ||
this.decodeMode === DecodingMode.Attribute &&
(valueLength === 0 ||
isEntityInAttributeInvalidEnd(char)) ? 0 : this.emitNotTerminatedNamedEntity();
        }
        current = decodeTree[this.treeIndex];
        valueLength = (current & BinTrieFlags.VALUE_LENGTH) >> 14;
        if (valueLength !== 0) {
          if (char === CharCodes.SEMI) {
            return this.emitNamedEntityData(this.treeIndex, valueLength, this.consumed + this.excess);
          }
          if (this.decodeMode !== DecodingMode.Strict) {
            this.result = this.treeIndex;
            this.consumed += this.excess;
            this.excess = 0;
          }
        }
      }
      return -1;
    }
emitNotTerminatedNamedEntity() {
      var _a2;
      const { result, decodeTree } = this;
      const valueLength = (decodeTree[result] & BinTrieFlags.VALUE_LENGTH) >> 14;
      this.emitNamedEntityData(result, valueLength, this.consumed);
      (_a2 = this.errors) === null || _a2 === void 0 ? void 0 : _a2.missingSemicolonAfterCharacterReference();
      return this.consumed;
    }
emitNamedEntityData(result, valueLength, consumed) {
      const { decodeTree } = this;
      this.emitCodePoint(valueLength === 1 ? decodeTree[result] & ~BinTrieFlags.VALUE_LENGTH : decodeTree[result + 1], consumed);
      if (valueLength === 3) {
        this.emitCodePoint(decodeTree[result + 2], consumed);
      }
      return consumed;
    }
end() {
      var _a2;
      switch (this.state) {
        case EntityDecoderState.NamedEntity: {
          return this.result !== 0 && (this.decodeMode !== DecodingMode.Attribute || this.result === this.treeIndex) ? this.emitNotTerminatedNamedEntity() : 0;
        }
case EntityDecoderState.NumericDecimal: {
          return this.emitNumericEntity(0, 2);
        }
        case EntityDecoderState.NumericHex: {
          return this.emitNumericEntity(0, 3);
        }
        case EntityDecoderState.NumericStart: {
          (_a2 = this.errors) === null || _a2 === void 0 ? void 0 : _a2.absenceOfDigitsInNumericCharacterReference(this.consumed);
          return 0;
        }
        case EntityDecoderState.EntityStart: {
          return 0;
        }
      }
    }
  }
  function getDecoder(decodeTree) {
    let ret = "";
    const decoder = new EntityDecoder(decodeTree, (str) => ret += fromCodePoint$1(str));
    return function decodeWithTrie(str, decodeMode) {
      let lastIndex = 0;
      let offset = 0;
      while ((offset = str.indexOf("&", offset)) >= 0) {
        ret += str.slice(lastIndex, offset);
        decoder.startEntity(decodeMode);
        const len = decoder.write(
          str,
offset + 1
        );
        if (len < 0) {
          lastIndex = offset + decoder.end();
          break;
        }
        lastIndex = offset + len;
        offset = len === 0 ? lastIndex + 1 : lastIndex;
      }
      const result = ret + str.slice(lastIndex);
      ret = "";
      return result;
    };
  }
  function determineBranch(decodeTree, current, nodeIdx, char) {
    const branchCount = (current & BinTrieFlags.BRANCH_LENGTH) >> 7;
    const jumpOffset = current & BinTrieFlags.JUMP_TABLE;
    if (branchCount === 0) {
      return jumpOffset !== 0 && char === jumpOffset ? nodeIdx : -1;
    }
    if (jumpOffset) {
      const value = char - jumpOffset;
      return value < 0 || value >= branchCount ? -1 : decodeTree[nodeIdx + value] - 1;
    }
    let lo = nodeIdx;
    let hi = lo + branchCount - 1;
    while (lo <= hi) {
      const mid = lo + hi >>> 1;
      const midVal = decodeTree[mid];
      if (midVal < char) {
        lo = mid + 1;
      } else if (midVal > char) {
        hi = mid - 1;
      } else {
        return decodeTree[mid + branchCount];
      }
    }
    return -1;
  }
  const htmlDecoder = getDecoder(htmlDecodeTree);
  getDecoder(xmlDecodeTree);
  function decodeHTML(str, mode = DecodingMode.Legacy) {
    return htmlDecoder(str, mode);
  }
  function _class$1(obj) {
    return Object.prototype.toString.call(obj);
  }
  function isString$1(obj) {
    return _class$1(obj) === "[object String]";
  }
  const _hasOwnProperty = Object.prototype.hasOwnProperty;
  function has(object, key) {
    return _hasOwnProperty.call(object, key);
  }
  function assign$1(obj) {
    const sources = Array.prototype.slice.call(arguments, 1);
    sources.forEach(function(source) {
      if (!source) {
        return;
      }
      if (typeof source !== "object") {
        throw new TypeError(source + "must be object");
      }
      Object.keys(source).forEach(function(key) {
        obj[key] = source[key];
      });
    });
    return obj;
  }
  function arrayReplaceAt(src, pos, newElements) {
    return [].concat(src.slice(0, pos), newElements, src.slice(pos + 1));
  }
  function isValidEntityCode(c) {
    if (c >= 55296 && c <= 57343) {
      return false;
    }
    if (c >= 64976 && c <= 65007) {
      return false;
    }
    if ((c & 65535) === 65535 || (c & 65535) === 65534) {
      return false;
    }
    if (c >= 0 && c <= 8) {
      return false;
    }
    if (c === 11) {
      return false;
    }
    if (c >= 14 && c <= 31) {
      return false;
    }
    if (c >= 127 && c <= 159) {
      return false;
    }
    if (c > 1114111) {
      return false;
    }
    return true;
  }
  function fromCodePoint(c) {
    if (c > 65535) {
      c -= 65536;
      const surrogate1 = 55296 + (c >> 10);
      const surrogate2 = 56320 + (c & 1023);
      return String.fromCharCode(surrogate1, surrogate2);
    }
    return String.fromCharCode(c);
  }
  const UNESCAPE_MD_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
  const ENTITY_RE = /&([a-z#][a-z0-9]{1,31});/gi;
  const UNESCAPE_ALL_RE = new RegExp(UNESCAPE_MD_RE.source + "|" + ENTITY_RE.source, "gi");
  const DIGITAL_ENTITY_TEST_RE = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;
  function replaceEntityPattern(match2, name) {
    if (name.charCodeAt(0) === 35 && DIGITAL_ENTITY_TEST_RE.test(name)) {
      const code2 = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (isValidEntityCode(code2)) {
        return fromCodePoint(code2);
      }
      return match2;
    }
    const decoded = decodeHTML(match2);
    if (decoded !== match2) {
      return decoded;
    }
    return match2;
  }
  function unescapeMd(str) {
    if (str.indexOf("\\") < 0) {
      return str;
    }
    return str.replace(UNESCAPE_MD_RE, "$1");
  }
  function unescapeAll(str) {
    if (str.indexOf("\\") < 0 && str.indexOf("&") < 0) {
      return str;
    }
    return str.replace(UNESCAPE_ALL_RE, function(match2, escaped, entity2) {
      if (escaped) {
        return escaped;
      }
      return replaceEntityPattern(match2, entity2);
    });
  }
  const HTML_ESCAPE_TEST_RE = /[&<>"]/;
  const HTML_ESCAPE_REPLACE_RE = /[&<>"]/g;
  const HTML_REPLACEMENTS = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  };
  function replaceUnsafeChar(ch) {
    return HTML_REPLACEMENTS[ch];
  }
  function escapeHtml(str) {
    if (HTML_ESCAPE_TEST_RE.test(str)) {
      return str.replace(HTML_ESCAPE_REPLACE_RE, replaceUnsafeChar);
    }
    return str;
  }
  const REGEXP_ESCAPE_RE = /[.?*+^$[\]\\(){}|-]/g;
  function escapeRE$1(str) {
    return str.replace(REGEXP_ESCAPE_RE, "\\$&");
  }
  function isSpace(code2) {
    switch (code2) {
      case 9:
      case 32:
        return true;
    }
    return false;
  }
  function isWhiteSpace(code2) {
    if (code2 >= 8192 && code2 <= 8202) {
      return true;
    }
    switch (code2) {
      case 9:
case 10:
case 11:
case 12:
case 13:
case 32:
      case 160:
      case 5760:
      case 8239:
      case 8287:
      case 12288:
        return true;
    }
    return false;
  }
  function isPunctChar(ch) {
    return P.test(ch) || regex.test(ch);
  }
  function isMdAsciiPunct(ch) {
    switch (ch) {
      case 33:
      case 34:
      case 35:
      case 36:
      case 37:
      case 38:
      case 39:
      case 40:
      case 41:
      case 42:
      case 43:
      case 44:
      case 45:
      case 46:
      case 47:
      case 58:
      case 59:
      case 60:
      case 61:
      case 62:
      case 63:
      case 64:
      case 91:
      case 92:
      case 93:
      case 94:
      case 95:
      case 96:
      case 123:
      case 124:
      case 125:
      case 126:
        return true;
      default:
        return false;
    }
  }
  function normalizeReference(str) {
    str = str.trim().replace(/\s+/g, " ");
    if ("ẞ".toLowerCase() === "Ṿ") {
      str = str.replace(/ẞ/g, "ß");
    }
    return str.toLowerCase().toUpperCase();
  }
  const lib = { mdurl, ucmicro };
  const utils = Object.freeze( Object.defineProperty({
    __proto__: null,
    arrayReplaceAt,
    assign: assign$1,
    escapeHtml,
    escapeRE: escapeRE$1,
    fromCodePoint,
    has,
    isMdAsciiPunct,
    isPunctChar,
    isSpace,
    isString: isString$1,
    isValidEntityCode,
    isWhiteSpace,
    lib,
    normalizeReference,
    unescapeAll,
    unescapeMd
  }, Symbol.toStringTag, { value: "Module" }));
  function parseLinkLabel(state2, start, disableNested) {
    let level, found, marker, prevPos;
    const max = state2.posMax;
    const oldPos = state2.pos;
    state2.pos = start + 1;
    level = 1;
    while (state2.pos < max) {
      marker = state2.src.charCodeAt(state2.pos);
      if (marker === 93) {
        level--;
        if (level === 0) {
          found = true;
          break;
        }
      }
      prevPos = state2.pos;
      state2.md.inline.skipToken(state2);
      if (marker === 91) {
        if (prevPos === state2.pos - 1) {
          level++;
        } else if (disableNested) {
          state2.pos = oldPos;
          return -1;
        }
      }
    }
    let labelEnd = -1;
    if (found) {
      labelEnd = state2.pos;
    }
    state2.pos = oldPos;
    return labelEnd;
  }
  function parseLinkDestination(str, start, max) {
    let code2;
    let pos = start;
    const result = {
      ok: false,
      pos: 0,
      str: ""
    };
    if (str.charCodeAt(pos) === 60) {
      pos++;
      while (pos < max) {
        code2 = str.charCodeAt(pos);
        if (code2 === 10) {
          return result;
        }
        if (code2 === 60) {
          return result;
        }
        if (code2 === 62) {
          result.pos = pos + 1;
          result.str = unescapeAll(str.slice(start + 1, pos));
          result.ok = true;
          return result;
        }
        if (code2 === 92 && pos + 1 < max) {
          pos += 2;
          continue;
        }
        pos++;
      }
      return result;
    }
    let level = 0;
    while (pos < max) {
      code2 = str.charCodeAt(pos);
      if (code2 === 32) {
        break;
      }
      if (code2 < 32 || code2 === 127) {
        break;
      }
      if (code2 === 92 && pos + 1 < max) {
        if (str.charCodeAt(pos + 1) === 32) {
          break;
        }
        pos += 2;
        continue;
      }
      if (code2 === 40) {
        level++;
        if (level > 32) {
          return result;
        }
      }
      if (code2 === 41) {
        if (level === 0) {
          break;
        }
        level--;
      }
      pos++;
    }
    if (start === pos) {
      return result;
    }
    if (level !== 0) {
      return result;
    }
    result.str = unescapeAll(str.slice(start, pos));
    result.pos = pos;
    result.ok = true;
    return result;
  }
  function parseLinkTitle(str, start, max, prev_state) {
    let code2;
    let pos = start;
    const state2 = {
ok: false,
can_continue: false,
pos: 0,
str: "",
marker: 0
    };
    if (prev_state) {
      state2.str = prev_state.str;
      state2.marker = prev_state.marker;
    } else {
      if (pos >= max) {
        return state2;
      }
      let marker = str.charCodeAt(pos);
      if (marker !== 34 && marker !== 39 && marker !== 40) {
        return state2;
      }
      start++;
      pos++;
      if (marker === 40) {
        marker = 41;
      }
      state2.marker = marker;
    }
    while (pos < max) {
      code2 = str.charCodeAt(pos);
      if (code2 === state2.marker) {
        state2.pos = pos + 1;
        state2.str += unescapeAll(str.slice(start, pos));
        state2.ok = true;
        return state2;
      } else if (code2 === 40 && state2.marker === 41) {
        return state2;
      } else if (code2 === 92 && pos + 1 < max) {
        pos++;
      }
      pos++;
    }
    state2.can_continue = true;
    state2.str += unescapeAll(str.slice(start, pos));
    return state2;
  }
  const helpers = Object.freeze( Object.defineProperty({
    __proto__: null,
    parseLinkDestination,
    parseLinkLabel,
    parseLinkTitle
  }, Symbol.toStringTag, { value: "Module" }));
  const default_rules = {};
  default_rules.code_inline = function(tokens, idx, options, env, slf) {
    const token = tokens[idx];
    return "<code" + slf.renderAttrs(token) + ">" + escapeHtml(token.content) + "</code>";
  };
  default_rules.code_block = function(tokens, idx, options, env, slf) {
    const token = tokens[idx];
    return "<pre" + slf.renderAttrs(token) + "><code>" + escapeHtml(tokens[idx].content) + "</code></pre>\n";
  };
  default_rules.fence = function(tokens, idx, options, env, slf) {
    const token = tokens[idx];
    const info = token.info ? unescapeAll(token.info).trim() : "";
    let langName = "";
    let langAttrs = "";
    if (info) {
      const arr = info.split(/(\s+)/g);
      langName = arr[0];
      langAttrs = arr.slice(2).join("");
    }
    let highlighted;
    if (options.highlight) {
      highlighted = options.highlight(token.content, langName, langAttrs) || escapeHtml(token.content);
    } else {
      highlighted = escapeHtml(token.content);
    }
    if (highlighted.indexOf("<pre") === 0) {
      return highlighted + "\n";
    }
    if (info) {
      const i = token.attrIndex("class");
      const tmpAttrs = token.attrs ? token.attrs.slice() : [];
      if (i < 0) {
        tmpAttrs.push(["class", options.langPrefix + langName]);
      } else {
        tmpAttrs[i] = tmpAttrs[i].slice();
        tmpAttrs[i][1] += " " + options.langPrefix + langName;
      }
      const tmpToken = {
        attrs: tmpAttrs
      };
      return `<pre><code${slf.renderAttrs(tmpToken)}>${highlighted}</code></pre>
`;
    }
    return `<pre><code${slf.renderAttrs(token)}>${highlighted}</code></pre>
`;
  };
  default_rules.image = function(tokens, idx, options, env, slf) {
    const token = tokens[idx];
    token.attrs[token.attrIndex("alt")][1] = slf.renderInlineAsText(token.children, options, env);
    return slf.renderToken(tokens, idx, options);
  };
  default_rules.hardbreak = function(tokens, idx, options) {
    return options.xhtmlOut ? "<br />\n" : "<br>\n";
  };
  default_rules.softbreak = function(tokens, idx, options) {
    return options.breaks ? options.xhtmlOut ? "<br />\n" : "<br>\n" : "\n";
  };
  default_rules.text = function(tokens, idx) {
    return escapeHtml(tokens[idx].content);
  };
  default_rules.html_block = function(tokens, idx) {
    return tokens[idx].content;
  };
  default_rules.html_inline = function(tokens, idx) {
    return tokens[idx].content;
  };
  function Renderer() {
    this.rules = assign$1({}, default_rules);
  }
  Renderer.prototype.renderAttrs = function renderAttrs(token) {
    let i, l, result;
    if (!token.attrs) {
      return "";
    }
    result = "";
    for (i = 0, l = token.attrs.length; i < l; i++) {
      result += " " + escapeHtml(token.attrs[i][0]) + '="' + escapeHtml(token.attrs[i][1]) + '"';
    }
    return result;
  };
  Renderer.prototype.renderToken = function renderToken(tokens, idx, options) {
    const token = tokens[idx];
    let result = "";
    if (token.hidden) {
      return "";
    }
    if (token.block && token.nesting !== -1 && idx && tokens[idx - 1].hidden) {
      result += "\n";
    }
    result += (token.nesting === -1 ? "</" : "<") + token.tag;
    result += this.renderAttrs(token);
    if (token.nesting === 0 && options.xhtmlOut) {
      result += " /";
    }
    let needLf = false;
    if (token.block) {
      needLf = true;
      if (token.nesting === 1) {
        if (idx + 1 < tokens.length) {
          const nextToken = tokens[idx + 1];
          if (nextToken.type === "inline" || nextToken.hidden) {
            needLf = false;
          } else if (nextToken.nesting === -1 && nextToken.tag === token.tag) {
            needLf = false;
          }
        }
      }
    }
    result += needLf ? ">\n" : ">";
    return result;
  };
  Renderer.prototype.renderInline = function(tokens, options, env) {
    let result = "";
    const rules = this.rules;
    for (let i = 0, len = tokens.length; i < len; i++) {
      const type = tokens[i].type;
      if (typeof rules[type] !== "undefined") {
        result += rules[type](tokens, i, options, env, this);
      } else {
        result += this.renderToken(tokens, i, options);
      }
    }
    return result;
  };
  Renderer.prototype.renderInlineAsText = function(tokens, options, env) {
    let result = "";
    for (let i = 0, len = tokens.length; i < len; i++) {
      switch (tokens[i].type) {
        case "text":
          result += tokens[i].content;
          break;
        case "image":
          result += this.renderInlineAsText(tokens[i].children, options, env);
          break;
        case "html_inline":
        case "html_block":
          result += tokens[i].content;
          break;
        case "softbreak":
        case "hardbreak":
          result += "\n";
          break;
      }
    }
    return result;
  };
  Renderer.prototype.render = function(tokens, options, env) {
    let result = "";
    const rules = this.rules;
    for (let i = 0, len = tokens.length; i < len; i++) {
      const type = tokens[i].type;
      if (type === "inline") {
        result += this.renderInline(tokens[i].children, options, env);
      } else if (typeof rules[type] !== "undefined") {
        result += rules[type](tokens, i, options, env, this);
      } else {
        result += this.renderToken(tokens, i, options, env);
      }
    }
    return result;
  };
  function Ruler() {
    this.__rules__ = [];
    this.__cache__ = null;
  }
  Ruler.prototype.__find__ = function(name) {
    for (let i = 0; i < this.__rules__.length; i++) {
      if (this.__rules__[i].name === name) {
        return i;
      }
    }
    return -1;
  };
  Ruler.prototype.__compile__ = function() {
    const self = this;
    const chains = [""];
    self.__rules__.forEach(function(rule) {
      if (!rule.enabled) {
        return;
      }
      rule.alt.forEach(function(altName) {
        if (chains.indexOf(altName) < 0) {
          chains.push(altName);
        }
      });
    });
    self.__cache__ = {};
    chains.forEach(function(chain) {
      self.__cache__[chain] = [];
      self.__rules__.forEach(function(rule) {
        if (!rule.enabled) {
          return;
        }
        if (chain && rule.alt.indexOf(chain) < 0) {
          return;
        }
        self.__cache__[chain].push(rule.fn);
      });
    });
  };
  Ruler.prototype.at = function(name, fn, options) {
    const index = this.__find__(name);
    const opt = options || {};
    if (index === -1) {
      throw new Error("Parser rule not found: " + name);
    }
    this.__rules__[index].fn = fn;
    this.__rules__[index].alt = opt.alt || [];
    this.__cache__ = null;
  };
  Ruler.prototype.before = function(beforeName, ruleName, fn, options) {
    const index = this.__find__(beforeName);
    const opt = options || {};
    if (index === -1) {
      throw new Error("Parser rule not found: " + beforeName);
    }
    this.__rules__.splice(index, 0, {
      name: ruleName,
      enabled: true,
      fn,
      alt: opt.alt || []
    });
    this.__cache__ = null;
  };
  Ruler.prototype.after = function(afterName, ruleName, fn, options) {
    const index = this.__find__(afterName);
    const opt = options || {};
    if (index === -1) {
      throw new Error("Parser rule not found: " + afterName);
    }
    this.__rules__.splice(index + 1, 0, {
      name: ruleName,
      enabled: true,
      fn,
      alt: opt.alt || []
    });
    this.__cache__ = null;
  };
  Ruler.prototype.push = function(ruleName, fn, options) {
    const opt = options || {};
    this.__rules__.push({
      name: ruleName,
      enabled: true,
      fn,
      alt: opt.alt || []
    });
    this.__cache__ = null;
  };
  Ruler.prototype.enable = function(list2, ignoreInvalid) {
    if (!Array.isArray(list2)) {
      list2 = [list2];
    }
    const result = [];
    list2.forEach(function(name) {
      const idx = this.__find__(name);
      if (idx < 0) {
        if (ignoreInvalid) {
          return;
        }
        throw new Error("Rules manager: invalid rule name " + name);
      }
      this.__rules__[idx].enabled = true;
      result.push(name);
    }, this);
    this.__cache__ = null;
    return result;
  };
  Ruler.prototype.enableOnly = function(list2, ignoreInvalid) {
    if (!Array.isArray(list2)) {
      list2 = [list2];
    }
    this.__rules__.forEach(function(rule) {
      rule.enabled = false;
    });
    this.enable(list2, ignoreInvalid);
  };
  Ruler.prototype.disable = function(list2, ignoreInvalid) {
    if (!Array.isArray(list2)) {
      list2 = [list2];
    }
    const result = [];
    list2.forEach(function(name) {
      const idx = this.__find__(name);
      if (idx < 0) {
        if (ignoreInvalid) {
          return;
        }
        throw new Error("Rules manager: invalid rule name " + name);
      }
      this.__rules__[idx].enabled = false;
      result.push(name);
    }, this);
    this.__cache__ = null;
    return result;
  };
  Ruler.prototype.getRules = function(chainName) {
    if (this.__cache__ === null) {
      this.__compile__();
    }
    return this.__cache__[chainName] || [];
  };
  function Token(type, tag, nesting) {
    this.type = type;
    this.tag = tag;
    this.attrs = null;
    this.map = null;
    this.nesting = nesting;
    this.level = 0;
    this.children = null;
    this.content = "";
    this.markup = "";
    this.info = "";
    this.meta = null;
    this.block = false;
    this.hidden = false;
  }
  Token.prototype.attrIndex = function attrIndex(name) {
    if (!this.attrs) {
      return -1;
    }
    const attrs = this.attrs;
    for (let i = 0, len = attrs.length; i < len; i++) {
      if (attrs[i][0] === name) {
        return i;
      }
    }
    return -1;
  };
  Token.prototype.attrPush = function attrPush(attrData) {
    if (this.attrs) {
      this.attrs.push(attrData);
    } else {
      this.attrs = [attrData];
    }
  };
  Token.prototype.attrSet = function attrSet(name, value) {
    const idx = this.attrIndex(name);
    const attrData = [name, value];
    if (idx < 0) {
      this.attrPush(attrData);
    } else {
      this.attrs[idx] = attrData;
    }
  };
  Token.prototype.attrGet = function attrGet(name) {
    const idx = this.attrIndex(name);
    let value = null;
    if (idx >= 0) {
      value = this.attrs[idx][1];
    }
    return value;
  };
  Token.prototype.attrJoin = function attrJoin(name, value) {
    const idx = this.attrIndex(name);
    if (idx < 0) {
      this.attrPush([name, value]);
    } else {
      this.attrs[idx][1] = this.attrs[idx][1] + " " + value;
    }
  };
  function StateCore(src, md, env) {
    this.src = src;
    this.env = env;
    this.tokens = [];
    this.inlineMode = false;
    this.md = md;
  }
  StateCore.prototype.Token = Token;
  const NEWLINES_RE = /\r\n?|\n/g;
  const NULL_RE = /\0/g;
  function normalize(state2) {
    let str;
    str = state2.src.replace(NEWLINES_RE, "\n");
    str = str.replace(NULL_RE, "�");
    state2.src = str;
  }
  function block(state2) {
    let token;
    if (state2.inlineMode) {
      token = new state2.Token("inline", "", 0);
      token.content = state2.src;
      token.map = [0, 1];
      token.children = [];
      state2.tokens.push(token);
    } else {
      state2.md.block.parse(state2.src, state2.md, state2.env, state2.tokens);
    }
  }
  function inline(state2) {
    const tokens = state2.tokens;
    for (let i = 0, l = tokens.length; i < l; i++) {
      const tok = tokens[i];
      if (tok.type === "inline") {
        state2.md.inline.parse(tok.content, state2.md, state2.env, tok.children);
      }
    }
  }
  function isLinkOpen$1(str) {
    return /^<a[>\s]/i.test(str);
  }
  function isLinkClose$1(str) {
    return /^<\/a\s*>/i.test(str);
  }
  function linkify$1(state2) {
    const blockTokens = state2.tokens;
    if (!state2.md.options.linkify) {
      return;
    }
    for (let j = 0, l = blockTokens.length; j < l; j++) {
      if (blockTokens[j].type !== "inline" || !state2.md.linkify.pretest(blockTokens[j].content)) {
        continue;
      }
      let tokens = blockTokens[j].children;
      let htmlLinkLevel = 0;
      for (let i = tokens.length - 1; i >= 0; i--) {
        const currentToken = tokens[i];
        if (currentToken.type === "link_close") {
          i--;
          while (tokens[i].level !== currentToken.level && tokens[i].type !== "link_open") {
            i--;
          }
          continue;
        }
        if (currentToken.type === "html_inline") {
          if (isLinkOpen$1(currentToken.content) && htmlLinkLevel > 0) {
            htmlLinkLevel--;
          }
          if (isLinkClose$1(currentToken.content)) {
            htmlLinkLevel++;
          }
        }
        if (htmlLinkLevel > 0) {
          continue;
        }
        if (currentToken.type === "text" && state2.md.linkify.test(currentToken.content)) {
          const text2 = currentToken.content;
          let links = state2.md.linkify.match(text2);
          const nodes = [];
          let level = currentToken.level;
          let lastPos = 0;
          if (links.length > 0 && links[0].index === 0 && i > 0 && tokens[i - 1].type === "text_special") {
            links = links.slice(1);
          }
          for (let ln = 0; ln < links.length; ln++) {
            const url = links[ln].url;
            const fullUrl = state2.md.normalizeLink(url);
            if (!state2.md.validateLink(fullUrl)) {
              continue;
            }
            let urlText = links[ln].text;
            if (!links[ln].schema) {
              urlText = state2.md.normalizeLinkText("http://" + urlText).replace(/^http:\/\//, "");
            } else if (links[ln].schema === "mailto:" && !/^mailto:/i.test(urlText)) {
              urlText = state2.md.normalizeLinkText("mailto:" + urlText).replace(/^mailto:/, "");
            } else {
              urlText = state2.md.normalizeLinkText(urlText);
            }
            const pos = links[ln].index;
            if (pos > lastPos) {
              const token = new state2.Token("text", "", 0);
              token.content = text2.slice(lastPos, pos);
              token.level = level;
              nodes.push(token);
            }
            const token_o = new state2.Token("link_open", "a", 1);
            token_o.attrs = [["href", fullUrl]];
            token_o.level = level++;
            token_o.markup = "linkify";
            token_o.info = "auto";
            nodes.push(token_o);
            const token_t = new state2.Token("text", "", 0);
            token_t.content = urlText;
            token_t.level = level;
            nodes.push(token_t);
            const token_c = new state2.Token("link_close", "a", -1);
            token_c.level = --level;
            token_c.markup = "linkify";
            token_c.info = "auto";
            nodes.push(token_c);
            lastPos = links[ln].lastIndex;
          }
          if (lastPos < text2.length) {
            const token = new state2.Token("text", "", 0);
            token.content = text2.slice(lastPos);
            token.level = level;
            nodes.push(token);
          }
          blockTokens[j].children = tokens = arrayReplaceAt(tokens, i, nodes);
        }
      }
    }
  }
  const RARE_RE = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/;
  const SCOPED_ABBR_TEST_RE = /\((c|tm|r)\)/i;
  const SCOPED_ABBR_RE = /\((c|tm|r)\)/ig;
  const SCOPED_ABBR = {
    c: "©",
    r: "®",
    tm: "™"
  };
  function replaceFn(match2, name) {
    return SCOPED_ABBR[name.toLowerCase()];
  }
  function replace_scoped(inlineTokens) {
    let inside_autolink = 0;
    for (let i = inlineTokens.length - 1; i >= 0; i--) {
      const token = inlineTokens[i];
      if (token.type === "text" && !inside_autolink) {
        token.content = token.content.replace(SCOPED_ABBR_RE, replaceFn);
      }
      if (token.type === "link_open" && token.info === "auto") {
        inside_autolink--;
      }
      if (token.type === "link_close" && token.info === "auto") {
        inside_autolink++;
      }
    }
  }
  function replace_rare(inlineTokens) {
    let inside_autolink = 0;
    for (let i = inlineTokens.length - 1; i >= 0; i--) {
      const token = inlineTokens[i];
      if (token.type === "text" && !inside_autolink) {
        if (RARE_RE.test(token.content)) {
          token.content = token.content.replace(/\+-/g, "±").replace(/\.{2,}/g, "…").replace(/([?!])…/g, "$1..").replace(/([?!]){4,}/g, "$1$1$1").replace(/,{2,}/g, ",").replace(/(^|[^-])---(?=[^-]|$)/mg, "$1—").replace(/(^|\s)--(?=\s|$)/mg, "$1–").replace(/(^|[^-\s])--(?=[^-\s]|$)/mg, "$1–");
        }
      }
      if (token.type === "link_open" && token.info === "auto") {
        inside_autolink--;
      }
      if (token.type === "link_close" && token.info === "auto") {
        inside_autolink++;
      }
    }
  }
  function replace(state2) {
    let blkIdx;
    if (!state2.md.options.typographer) {
      return;
    }
    for (blkIdx = state2.tokens.length - 1; blkIdx >= 0; blkIdx--) {
      if (state2.tokens[blkIdx].type !== "inline") {
        continue;
      }
      if (SCOPED_ABBR_TEST_RE.test(state2.tokens[blkIdx].content)) {
        replace_scoped(state2.tokens[blkIdx].children);
      }
      if (RARE_RE.test(state2.tokens[blkIdx].content)) {
        replace_rare(state2.tokens[blkIdx].children);
      }
    }
  }
  const QUOTE_TEST_RE = /['"]/;
  const QUOTE_RE = /['"]/g;
  const APOSTROPHE = "’";
  function replaceAt(str, index, ch) {
    return str.slice(0, index) + ch + str.slice(index + 1);
  }
  function process_inlines(tokens, state2) {
    let j;
    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const thisLevel = tokens[i].level;
      for (j = stack.length - 1; j >= 0; j--) {
        if (stack[j].level <= thisLevel) {
          break;
        }
      }
      stack.length = j + 1;
      if (token.type !== "text") {
        continue;
      }
      let text2 = token.content;
      let pos = 0;
      let max = text2.length;
      OUTER:
        while (pos < max) {
          QUOTE_RE.lastIndex = pos;
          const t = QUOTE_RE.exec(text2);
          if (!t) {
            break;
          }
          let canOpen = true;
          let canClose = true;
          pos = t.index + 1;
          const isSingle = t[0] === "'";
          let lastChar = 32;
          if (t.index - 1 >= 0) {
            lastChar = text2.charCodeAt(t.index - 1);
          } else {
            for (j = i - 1; j >= 0; j--) {
              if (tokens[j].type === "softbreak" || tokens[j].type === "hardbreak") break;
              if (!tokens[j].content) continue;
              lastChar = tokens[j].content.charCodeAt(tokens[j].content.length - 1);
              break;
            }
          }
          let nextChar = 32;
          if (pos < max) {
            nextChar = text2.charCodeAt(pos);
          } else {
            for (j = i + 1; j < tokens.length; j++) {
              if (tokens[j].type === "softbreak" || tokens[j].type === "hardbreak") break;
              if (!tokens[j].content) continue;
              nextChar = tokens[j].content.charCodeAt(0);
              break;
            }
          }
          const isLastPunctChar = isMdAsciiPunct(lastChar) || isPunctChar(String.fromCharCode(lastChar));
          const isNextPunctChar = isMdAsciiPunct(nextChar) || isPunctChar(String.fromCharCode(nextChar));
          const isLastWhiteSpace = isWhiteSpace(lastChar);
          const isNextWhiteSpace = isWhiteSpace(nextChar);
          if (isNextWhiteSpace) {
            canOpen = false;
          } else if (isNextPunctChar) {
            if (!(isLastWhiteSpace || isLastPunctChar)) {
              canOpen = false;
            }
          }
          if (isLastWhiteSpace) {
            canClose = false;
          } else if (isLastPunctChar) {
            if (!(isNextWhiteSpace || isNextPunctChar)) {
              canClose = false;
            }
          }
          if (nextChar === 34 && t[0] === '"') {
            if (lastChar >= 48 && lastChar <= 57) {
              canClose = canOpen = false;
            }
          }
          if (canOpen && canClose) {
            canOpen = isLastPunctChar;
            canClose = isNextPunctChar;
          }
          if (!canOpen && !canClose) {
            if (isSingle) {
              token.content = replaceAt(token.content, t.index, APOSTROPHE);
            }
            continue;
          }
          if (canClose) {
            for (j = stack.length - 1; j >= 0; j--) {
              let item = stack[j];
              if (stack[j].level < thisLevel) {
                break;
              }
              if (item.single === isSingle && stack[j].level === thisLevel) {
                item = stack[j];
                let openQuote;
                let closeQuote;
                if (isSingle) {
                  openQuote = state2.md.options.quotes[2];
                  closeQuote = state2.md.options.quotes[3];
                } else {
                  openQuote = state2.md.options.quotes[0];
                  closeQuote = state2.md.options.quotes[1];
                }
                token.content = replaceAt(token.content, t.index, closeQuote);
                tokens[item.token].content = replaceAt(
                  tokens[item.token].content,
                  item.pos,
                  openQuote
                );
                pos += closeQuote.length - 1;
                if (item.token === i) {
                  pos += openQuote.length - 1;
                }
                text2 = token.content;
                max = text2.length;
                stack.length = j;
                continue OUTER;
              }
            }
          }
          if (canOpen) {
            stack.push({
              token: i,
              pos: t.index,
              single: isSingle,
              level: thisLevel
            });
          } else if (canClose && isSingle) {
            token.content = replaceAt(token.content, t.index, APOSTROPHE);
          }
        }
    }
  }
  function smartquotes(state2) {
    if (!state2.md.options.typographer) {
      return;
    }
    for (let blkIdx = state2.tokens.length - 1; blkIdx >= 0; blkIdx--) {
      if (state2.tokens[blkIdx].type !== "inline" || !QUOTE_TEST_RE.test(state2.tokens[blkIdx].content)) {
        continue;
      }
      process_inlines(state2.tokens[blkIdx].children, state2);
    }
  }
  function text_join(state2) {
    let curr, last;
    const blockTokens = state2.tokens;
    const l = blockTokens.length;
    for (let j = 0; j < l; j++) {
      if (blockTokens[j].type !== "inline") continue;
      const tokens = blockTokens[j].children;
      const max = tokens.length;
      for (curr = 0; curr < max; curr++) {
        if (tokens[curr].type === "text_special") {
          tokens[curr].type = "text";
        }
      }
      for (curr = last = 0; curr < max; curr++) {
        if (tokens[curr].type === "text" && curr + 1 < max && tokens[curr + 1].type === "text") {
          tokens[curr + 1].content = tokens[curr].content + tokens[curr + 1].content;
        } else {
          if (curr !== last) {
            tokens[last] = tokens[curr];
          }
          last++;
        }
      }
      if (curr !== last) {
        tokens.length = last;
      }
    }
  }
  const _rules$2 = [
    ["normalize", normalize],
    ["block", block],
    ["inline", inline],
    ["linkify", linkify$1],
    ["replacements", replace],
    ["smartquotes", smartquotes],

["text_join", text_join]
  ];
  function Core() {
    this.ruler = new Ruler();
    for (let i = 0; i < _rules$2.length; i++) {
      this.ruler.push(_rules$2[i][0], _rules$2[i][1]);
    }
  }
  Core.prototype.process = function(state2) {
    const rules = this.ruler.getRules("");
    for (let i = 0, l = rules.length; i < l; i++) {
      rules[i](state2);
    }
  };
  Core.prototype.State = StateCore;
  function StateBlock(src, md, env, tokens) {
    this.src = src;
    this.md = md;
    this.env = env;
    this.tokens = tokens;
    this.bMarks = [];
    this.eMarks = [];
    this.tShift = [];
    this.sCount = [];
    this.bsCount = [];
    this.blkIndent = 0;
    this.line = 0;
    this.lineMax = 0;
    this.tight = false;
    this.ddIndent = -1;
    this.listIndent = -1;
    this.parentType = "root";
    this.level = 0;
    const s = this.src;
    for (let start = 0, pos = 0, indent = 0, offset = 0, len = s.length, indent_found = false; pos < len; pos++) {
      const ch = s.charCodeAt(pos);
      if (!indent_found) {
        if (isSpace(ch)) {
          indent++;
          if (ch === 9) {
            offset += 4 - offset % 4;
          } else {
            offset++;
          }
          continue;
        } else {
          indent_found = true;
        }
      }
      if (ch === 10 || pos === len - 1) {
        if (ch !== 10) {
          pos++;
        }
        this.bMarks.push(start);
        this.eMarks.push(pos);
        this.tShift.push(indent);
        this.sCount.push(offset);
        this.bsCount.push(0);
        indent_found = false;
        indent = 0;
        offset = 0;
        start = pos + 1;
      }
    }
    this.bMarks.push(s.length);
    this.eMarks.push(s.length);
    this.tShift.push(0);
    this.sCount.push(0);
    this.bsCount.push(0);
    this.lineMax = this.bMarks.length - 1;
  }
  StateBlock.prototype.push = function(type, tag, nesting) {
    const token = new Token(type, tag, nesting);
    token.block = true;
    if (nesting < 0) this.level--;
    token.level = this.level;
    if (nesting > 0) this.level++;
    this.tokens.push(token);
    return token;
  };
  StateBlock.prototype.isEmpty = function isEmpty(line) {
    return this.bMarks[line] + this.tShift[line] >= this.eMarks[line];
  };
  StateBlock.prototype.skipEmptyLines = function skipEmptyLines(from) {
    for (let max = this.lineMax; from < max; from++) {
      if (this.bMarks[from] + this.tShift[from] < this.eMarks[from]) {
        break;
      }
    }
    return from;
  };
  StateBlock.prototype.skipSpaces = function skipSpaces(pos) {
    for (let max = this.src.length; pos < max; pos++) {
      const ch = this.src.charCodeAt(pos);
      if (!isSpace(ch)) {
        break;
      }
    }
    return pos;
  };
  StateBlock.prototype.skipSpacesBack = function skipSpacesBack(pos, min) {
    if (pos <= min) {
      return pos;
    }
    while (pos > min) {
      if (!isSpace(this.src.charCodeAt(--pos))) {
        return pos + 1;
      }
    }
    return pos;
  };
  StateBlock.prototype.skipChars = function skipChars(pos, code2) {
    for (let max = this.src.length; pos < max; pos++) {
      if (this.src.charCodeAt(pos) !== code2) {
        break;
      }
    }
    return pos;
  };
  StateBlock.prototype.skipCharsBack = function skipCharsBack(pos, code2, min) {
    if (pos <= min) {
      return pos;
    }
    while (pos > min) {
      if (code2 !== this.src.charCodeAt(--pos)) {
        return pos + 1;
      }
    }
    return pos;
  };
  StateBlock.prototype.getLines = function getLines(begin, end, indent, keepLastLF) {
    if (begin >= end) {
      return "";
    }
    const queue = new Array(end - begin);
    for (let i = 0, line = begin; line < end; line++, i++) {
      let lineIndent = 0;
      const lineStart = this.bMarks[line];
      let first = lineStart;
      let last;
      if (line + 1 < end || keepLastLF) {
        last = this.eMarks[line] + 1;
      } else {
        last = this.eMarks[line];
      }
      while (first < last && lineIndent < indent) {
        const ch = this.src.charCodeAt(first);
        if (isSpace(ch)) {
          if (ch === 9) {
            lineIndent += 4 - (lineIndent + this.bsCount[line]) % 4;
          } else {
            lineIndent++;
          }
        } else if (first - lineStart < this.tShift[line]) {
          lineIndent++;
        } else {
          break;
        }
        first++;
      }
      if (lineIndent > indent) {
        queue[i] = new Array(lineIndent - indent + 1).join(" ") + this.src.slice(first, last);
      } else {
        queue[i] = this.src.slice(first, last);
      }
    }
    return queue.join("");
  };
  StateBlock.prototype.Token = Token;
  const MAX_AUTOCOMPLETED_CELLS = 65536;
  function getLine(state2, line) {
    const pos = state2.bMarks[line] + state2.tShift[line];
    const max = state2.eMarks[line];
    return state2.src.slice(pos, max);
  }
  function escapedSplit(str) {
    const result = [];
    const max = str.length;
    let pos = 0;
    let ch = str.charCodeAt(pos);
    let isEscaped = false;
    let lastPos = 0;
    let current = "";
    while (pos < max) {
      if (ch === 124) {
        if (!isEscaped) {
          result.push(current + str.substring(lastPos, pos));
          current = "";
          lastPos = pos + 1;
        } else {
          current += str.substring(lastPos, pos - 1);
          lastPos = pos;
        }
      }
      isEscaped = ch === 92;
      pos++;
      ch = str.charCodeAt(pos);
    }
    result.push(current + str.substring(lastPos));
    return result;
  }
  function table(state2, startLine, endLine, silent) {
    if (startLine + 2 > endLine) {
      return false;
    }
    let nextLine = startLine + 1;
    if (state2.sCount[nextLine] < state2.blkIndent) {
      return false;
    }
    if (state2.sCount[nextLine] - state2.blkIndent >= 4) {
      return false;
    }
    let pos = state2.bMarks[nextLine] + state2.tShift[nextLine];
    if (pos >= state2.eMarks[nextLine]) {
      return false;
    }
    const firstCh = state2.src.charCodeAt(pos++);
    if (firstCh !== 124 && firstCh !== 45 && firstCh !== 58) {
      return false;
    }
    if (pos >= state2.eMarks[nextLine]) {
      return false;
    }
    const secondCh = state2.src.charCodeAt(pos++);
    if (secondCh !== 124 && secondCh !== 45 && secondCh !== 58 && !isSpace(secondCh)) {
      return false;
    }
    if (firstCh === 45 && isSpace(secondCh)) {
      return false;
    }
    while (pos < state2.eMarks[nextLine]) {
      const ch = state2.src.charCodeAt(pos);
      if (ch !== 124 && ch !== 45 && ch !== 58 && !isSpace(ch)) {
        return false;
      }
      pos++;
    }
    let lineText = getLine(state2, startLine + 1);
    let columns = lineText.split("|");
    const aligns = [];
    for (let i = 0; i < columns.length; i++) {
      const t = columns[i].trim();
      if (!t) {
        if (i === 0 || i === columns.length - 1) {
          continue;
        } else {
          return false;
        }
      }
      if (!/^:?-+:?$/.test(t)) {
        return false;
      }
      if (t.charCodeAt(t.length - 1) === 58) {
        aligns.push(t.charCodeAt(0) === 58 ? "center" : "right");
      } else if (t.charCodeAt(0) === 58) {
        aligns.push("left");
      } else {
        aligns.push("");
      }
    }
    lineText = getLine(state2, startLine).trim();
    if (lineText.indexOf("|") === -1) {
      return false;
    }
    if (state2.sCount[startLine] - state2.blkIndent >= 4) {
      return false;
    }
    columns = escapedSplit(lineText);
    if (columns.length && columns[0] === "") columns.shift();
    if (columns.length && columns[columns.length - 1] === "") columns.pop();
    const columnCount = columns.length;
    if (columnCount === 0 || columnCount !== aligns.length) {
      return false;
    }
    if (silent) {
      return true;
    }
    const oldParentType = state2.parentType;
    state2.parentType = "table";
    const terminatorRules = state2.md.block.ruler.getRules("blockquote");
    const token_to = state2.push("table_open", "table", 1);
    const tableLines = [startLine, 0];
    token_to.map = tableLines;
    const token_tho = state2.push("thead_open", "thead", 1);
    token_tho.map = [startLine, startLine + 1];
    const token_htro = state2.push("tr_open", "tr", 1);
    token_htro.map = [startLine, startLine + 1];
    for (let i = 0; i < columns.length; i++) {
      const token_ho = state2.push("th_open", "th", 1);
      if (aligns[i]) {
        token_ho.attrs = [["style", "text-align:" + aligns[i]]];
      }
      const token_il = state2.push("inline", "", 0);
      token_il.content = columns[i].trim();
      token_il.children = [];
      state2.push("th_close", "th", -1);
    }
    state2.push("tr_close", "tr", -1);
    state2.push("thead_close", "thead", -1);
    let tbodyLines;
    let autocompletedCells = 0;
    for (nextLine = startLine + 2; nextLine < endLine; nextLine++) {
      if (state2.sCount[nextLine] < state2.blkIndent) {
        break;
      }
      let terminate = false;
      for (let i = 0, l = terminatorRules.length; i < l; i++) {
        if (terminatorRules[i](state2, nextLine, endLine, true)) {
          terminate = true;
          break;
        }
      }
      if (terminate) {
        break;
      }
      lineText = getLine(state2, nextLine).trim();
      if (!lineText) {
        break;
      }
      if (state2.sCount[nextLine] - state2.blkIndent >= 4) {
        break;
      }
      columns = escapedSplit(lineText);
      if (columns.length && columns[0] === "") columns.shift();
      if (columns.length && columns[columns.length - 1] === "") columns.pop();
      autocompletedCells += columnCount - columns.length;
      if (autocompletedCells > MAX_AUTOCOMPLETED_CELLS) {
        break;
      }
      if (nextLine === startLine + 2) {
        const token_tbo = state2.push("tbody_open", "tbody", 1);
        token_tbo.map = tbodyLines = [startLine + 2, 0];
      }
      const token_tro = state2.push("tr_open", "tr", 1);
      token_tro.map = [nextLine, nextLine + 1];
      for (let i = 0; i < columnCount; i++) {
        const token_tdo = state2.push("td_open", "td", 1);
        if (aligns[i]) {
          token_tdo.attrs = [["style", "text-align:" + aligns[i]]];
        }
        const token_il = state2.push("inline", "", 0);
        token_il.content = columns[i] ? columns[i].trim() : "";
        token_il.children = [];
        state2.push("td_close", "td", -1);
      }
      state2.push("tr_close", "tr", -1);
    }
    if (tbodyLines) {
      state2.push("tbody_close", "tbody", -1);
      tbodyLines[1] = nextLine;
    }
    state2.push("table_close", "table", -1);
    tableLines[1] = nextLine;
    state2.parentType = oldParentType;
    state2.line = nextLine;
    return true;
  }
  function code(state2, startLine, endLine) {
    if (state2.sCount[startLine] - state2.blkIndent < 4) {
      return false;
    }
    let nextLine = startLine + 1;
    let last = nextLine;
    while (nextLine < endLine) {
      if (state2.isEmpty(nextLine)) {
        nextLine++;
        continue;
      }
      if (state2.sCount[nextLine] - state2.blkIndent >= 4) {
        nextLine++;
        last = nextLine;
        continue;
      }
      break;
    }
    state2.line = last;
    const token = state2.push("code_block", "code", 0);
    token.content = state2.getLines(startLine, last, 4 + state2.blkIndent, false) + "\n";
    token.map = [startLine, state2.line];
    return true;
  }
  function fence(state2, startLine, endLine, silent) {
    let pos = state2.bMarks[startLine] + state2.tShift[startLine];
    let max = state2.eMarks[startLine];
    if (state2.sCount[startLine] - state2.blkIndent >= 4) {
      return false;
    }
    if (pos + 3 > max) {
      return false;
    }
    const marker = state2.src.charCodeAt(pos);
    if (marker !== 126 && marker !== 96) {
      return false;
    }
    let mem = pos;
    pos = state2.skipChars(pos, marker);
    let len = pos - mem;
    if (len < 3) {
      return false;
    }
    const markup = state2.src.slice(mem, pos);
    const params = state2.src.slice(pos, max);
    if (marker === 96) {
      if (params.indexOf(String.fromCharCode(marker)) >= 0) {
        return false;
      }
    }
    if (silent) {
      return true;
    }
    let nextLine = startLine;
    let haveEndMarker = false;
    for (; ; ) {
      nextLine++;
      if (nextLine >= endLine) {
        break;
      }
      pos = mem = state2.bMarks[nextLine] + state2.tShift[nextLine];
      max = state2.eMarks[nextLine];
      if (pos < max && state2.sCount[nextLine] < state2.blkIndent) {
        break;
      }
      if (state2.src.charCodeAt(pos) !== marker) {
        continue;
      }
      if (state2.sCount[nextLine] - state2.blkIndent >= 4) {
        continue;
      }
      pos = state2.skipChars(pos, marker);
      if (pos - mem < len) {
        continue;
      }
      pos = state2.skipSpaces(pos);
      if (pos < max) {
        continue;
      }
      haveEndMarker = true;
      break;
    }
    len = state2.sCount[startLine];
    state2.line = nextLine + (haveEndMarker ? 1 : 0);
    const token = state2.push("fence", "code", 0);
    token.info = params;
    token.content = state2.getLines(startLine + 1, nextLine, len, true);
    token.markup = markup;
    token.map = [startLine, state2.line];
    return true;
  }
  function blockquote(state2, startLine, endLine, silent) {
    let pos = state2.bMarks[startLine] + state2.tShift[startLine];
    let max = state2.eMarks[startLine];
    const oldLineMax = state2.lineMax;
    if (state2.sCount[startLine] - state2.blkIndent >= 4) {
      return false;
    }
    if (state2.src.charCodeAt(pos) !== 62) {
      return false;
    }
    if (silent) {
      return true;
    }
    const oldBMarks = [];
    const oldBSCount = [];
    const oldSCount = [];
    const oldTShift = [];
    const terminatorRules = state2.md.block.ruler.getRules("blockquote");
    const oldParentType = state2.parentType;
    state2.parentType = "blockquote";
    let lastLineEmpty = false;
    let nextLine;
    for (nextLine = startLine; nextLine < endLine; nextLine++) {
      const isOutdented = state2.sCount[nextLine] < state2.blkIndent;
      pos = state2.bMarks[nextLine] + state2.tShift[nextLine];
      max = state2.eMarks[nextLine];
      if (pos >= max) {
        break;
      }
      if (state2.src.charCodeAt(pos++) === 62 && !isOutdented) {
        let initial = state2.sCount[nextLine] + 1;
        let spaceAfterMarker;
        let adjustTab;
        if (state2.src.charCodeAt(pos) === 32) {
          pos++;
          initial++;
          adjustTab = false;
          spaceAfterMarker = true;
        } else if (state2.src.charCodeAt(pos) === 9) {
          spaceAfterMarker = true;
          if ((state2.bsCount[nextLine] + initial) % 4 === 3) {
            pos++;
            initial++;
            adjustTab = false;
          } else {
            adjustTab = true;
          }
        } else {
          spaceAfterMarker = false;
        }
        let offset = initial;
        oldBMarks.push(state2.bMarks[nextLine]);
        state2.bMarks[nextLine] = pos;
        while (pos < max) {
          const ch = state2.src.charCodeAt(pos);
          if (isSpace(ch)) {
            if (ch === 9) {
              offset += 4 - (offset + state2.bsCount[nextLine] + (adjustTab ? 1 : 0)) % 4;
            } else {
              offset++;
            }
          } else {
            break;
          }
          pos++;
        }
        lastLineEmpty = pos >= max;
        oldBSCount.push(state2.bsCount[nextLine]);
        state2.bsCount[nextLine] = state2.sCount[nextLine] + 1 + (spaceAfterMarker ? 1 : 0);
        oldSCount.push(state2.sCount[nextLine]);
        state2.sCount[nextLine] = offset - initial;
        oldTShift.push(state2.tShift[nextLine]);
        state2.tShift[nextLine] = pos - state2.bMarks[nextLine];
        continue;
      }
      if (lastLineEmpty) {
        break;
      }
      let terminate = false;
      for (let i = 0, l = terminatorRules.length; i < l; i++) {
        if (terminatorRules[i](state2, nextLine, endLine, true)) {
          terminate = true;
          break;
        }
      }
      if (terminate) {
        state2.lineMax = nextLine;
        if (state2.blkIndent !== 0) {
          oldBMarks.push(state2.bMarks[nextLine]);
          oldBSCount.push(state2.bsCount[nextLine]);
          oldTShift.push(state2.tShift[nextLine]);
          oldSCount.push(state2.sCount[nextLine]);
          state2.sCount[nextLine] -= state2.blkIndent;
        }
        break;
      }
      oldBMarks.push(state2.bMarks[nextLine]);
      oldBSCount.push(state2.bsCount[nextLine]);
      oldTShift.push(state2.tShift[nextLine]);
      oldSCount.push(state2.sCount[nextLine]);
      state2.sCount[nextLine] = -1;
    }
    const oldIndent = state2.blkIndent;
    state2.blkIndent = 0;
    const token_o = state2.push("blockquote_open", "blockquote", 1);
    token_o.markup = ">";
    const lines = [startLine, 0];
    token_o.map = lines;
    state2.md.block.tokenize(state2, startLine, nextLine);
    const token_c = state2.push("blockquote_close", "blockquote", -1);
    token_c.markup = ">";
    state2.lineMax = oldLineMax;
    state2.parentType = oldParentType;
    lines[1] = state2.line;
    for (let i = 0; i < oldTShift.length; i++) {
      state2.bMarks[i + startLine] = oldBMarks[i];
      state2.tShift[i + startLine] = oldTShift[i];
      state2.sCount[i + startLine] = oldSCount[i];
      state2.bsCount[i + startLine] = oldBSCount[i];
    }
    state2.blkIndent = oldIndent;
    return true;
  }
  function hr(state2, startLine, endLine, silent) {
    const max = state2.eMarks[startLine];
    if (state2.sCount[startLine] - state2.blkIndent >= 4) {
      return false;
    }
    let pos = state2.bMarks[startLine] + state2.tShift[startLine];
    const marker = state2.src.charCodeAt(pos++);
    if (marker !== 42 && marker !== 45 && marker !== 95) {
      return false;
    }
    let cnt = 1;
    while (pos < max) {
      const ch = state2.src.charCodeAt(pos++);
      if (ch !== marker && !isSpace(ch)) {
        return false;
      }
      if (ch === marker) {
        cnt++;
      }
    }
    if (cnt < 3) {
      return false;
    }
    if (silent) {
      return true;
    }
    state2.line = startLine + 1;
    const token = state2.push("hr", "hr", 0);
    token.map = [startLine, state2.line];
    token.markup = Array(cnt + 1).join(String.fromCharCode(marker));
    return true;
  }
  function skipBulletListMarker(state2, startLine) {
    const max = state2.eMarks[startLine];
    let pos = state2.bMarks[startLine] + state2.tShift[startLine];
    const marker = state2.src.charCodeAt(pos++);
    if (marker !== 42 && marker !== 45 && marker !== 43) {
      return -1;
    }
    if (pos < max) {
      const ch = state2.src.charCodeAt(pos);
      if (!isSpace(ch)) {
        return -1;
      }
    }
    return pos;
  }
  function skipOrderedListMarker(state2, startLine) {
    const start = state2.bMarks[startLine] + state2.tShift[startLine];
    const max = state2.eMarks[startLine];
    let pos = start;
    if (pos + 1 >= max) {
      return -1;
    }
    let ch = state2.src.charCodeAt(pos++);
    if (ch < 48 || ch > 57) {
      return -1;
    }
    for (; ; ) {
      if (pos >= max) {
        return -1;
      }
      ch = state2.src.charCodeAt(pos++);
      if (ch >= 48 && ch <= 57) {
        if (pos - start >= 10) {
          return -1;
        }
        continue;
      }
      if (ch === 41 || ch === 46) {
        break;
      }
      return -1;
    }
    if (pos < max) {
      ch = state2.src.charCodeAt(pos);
      if (!isSpace(ch)) {
        return -1;
      }
    }
    return pos;
  }
  function markTightParagraphs(state2, idx) {
    const level = state2.level + 2;
    for (let i = idx + 2, l = state2.tokens.length - 2; i < l; i++) {
      if (state2.tokens[i].level === level && state2.tokens[i].type === "paragraph_open") {
        state2.tokens[i + 2].hidden = true;
        state2.tokens[i].hidden = true;
        i += 2;
      }
    }
  }
  function list(state2, startLine, endLine, silent) {
    let max, pos, start, token;
    let nextLine = startLine;
    let tight = true;
    if (state2.sCount[nextLine] - state2.blkIndent >= 4) {
      return false;
    }
    if (state2.listIndent >= 0 && state2.sCount[nextLine] - state2.listIndent >= 4 && state2.sCount[nextLine] < state2.blkIndent) {
      return false;
    }
    let isTerminatingParagraph = false;
    if (silent && state2.parentType === "paragraph") {
      if (state2.sCount[nextLine] >= state2.blkIndent) {
        isTerminatingParagraph = true;
      }
    }
    let isOrdered;
    let markerValue;
    let posAfterMarker;
    if ((posAfterMarker = skipOrderedListMarker(state2, nextLine)) >= 0) {
      isOrdered = true;
      start = state2.bMarks[nextLine] + state2.tShift[nextLine];
      markerValue = Number(state2.src.slice(start, posAfterMarker - 1));
      if (isTerminatingParagraph && markerValue !== 1) return false;
    } else if ((posAfterMarker = skipBulletListMarker(state2, nextLine)) >= 0) {
      isOrdered = false;
    } else {
      return false;
    }
    if (isTerminatingParagraph) {
      if (state2.skipSpaces(posAfterMarker) >= state2.eMarks[nextLine]) return false;
    }
    if (silent) {
      return true;
    }
    const markerCharCode = state2.src.charCodeAt(posAfterMarker - 1);
    const listTokIdx = state2.tokens.length;
    if (isOrdered) {
      token = state2.push("ordered_list_open", "ol", 1);
      if (markerValue !== 1) {
        token.attrs = [["start", markerValue]];
      }
    } else {
      token = state2.push("bullet_list_open", "ul", 1);
    }
    const listLines = [nextLine, 0];
    token.map = listLines;
    token.markup = String.fromCharCode(markerCharCode);
    let prevEmptyEnd = false;
    const terminatorRules = state2.md.block.ruler.getRules("list");
    const oldParentType = state2.parentType;
    state2.parentType = "list";
    while (nextLine < endLine) {
      pos = posAfterMarker;
      max = state2.eMarks[nextLine];
      const initial = state2.sCount[nextLine] + posAfterMarker - (state2.bMarks[nextLine] + state2.tShift[nextLine]);
      let offset = initial;
      while (pos < max) {
        const ch = state2.src.charCodeAt(pos);
        if (ch === 9) {
          offset += 4 - (offset + state2.bsCount[nextLine]) % 4;
        } else if (ch === 32) {
          offset++;
        } else {
          break;
        }
        pos++;
      }
      const contentStart = pos;
      let indentAfterMarker;
      if (contentStart >= max) {
        indentAfterMarker = 1;
      } else {
        indentAfterMarker = offset - initial;
      }
      if (indentAfterMarker > 4) {
        indentAfterMarker = 1;
      }
      const indent = initial + indentAfterMarker;
      token = state2.push("list_item_open", "li", 1);
      token.markup = String.fromCharCode(markerCharCode);
      const itemLines = [nextLine, 0];
      token.map = itemLines;
      if (isOrdered) {
        token.info = state2.src.slice(start, posAfterMarker - 1);
      }
      const oldTight = state2.tight;
      const oldTShift = state2.tShift[nextLine];
      const oldSCount = state2.sCount[nextLine];
      const oldListIndent = state2.listIndent;
      state2.listIndent = state2.blkIndent;
      state2.blkIndent = indent;
      state2.tight = true;
      state2.tShift[nextLine] = contentStart - state2.bMarks[nextLine];
      state2.sCount[nextLine] = offset;
      if (contentStart >= max && state2.isEmpty(nextLine + 1)) {
        state2.line = Math.min(state2.line + 2, endLine);
      } else {
        state2.md.block.tokenize(state2, nextLine, endLine, true);
      }
      if (!state2.tight || prevEmptyEnd) {
        tight = false;
      }
      prevEmptyEnd = state2.line - nextLine > 1 && state2.isEmpty(state2.line - 1);
      state2.blkIndent = state2.listIndent;
      state2.listIndent = oldListIndent;
      state2.tShift[nextLine] = oldTShift;
      state2.sCount[nextLine] = oldSCount;
      state2.tight = oldTight;
      token = state2.push("list_item_close", "li", -1);
      token.markup = String.fromCharCode(markerCharCode);
      nextLine = state2.line;
      itemLines[1] = nextLine;
      if (nextLine >= endLine) {
        break;
      }
      if (state2.sCount[nextLine] < state2.blkIndent) {
        break;
      }
      if (state2.sCount[nextLine] - state2.blkIndent >= 4) {
        break;
      }
      let terminate = false;
      for (let i = 0, l = terminatorRules.length; i < l; i++) {
        if (terminatorRules[i](state2, nextLine, endLine, true)) {
          terminate = true;
          break;
        }
      }
      if (terminate) {
        break;
      }
      if (isOrdered) {
        posAfterMarker = skipOrderedListMarker(state2, nextLine);
        if (posAfterMarker < 0) {
          break;
        }
        start = state2.bMarks[nextLine] + state2.tShift[nextLine];
      } else {
        posAfterMarker = skipBulletListMarker(state2, nextLine);
        if (posAfterMarker < 0) {
          break;
        }
      }
      if (markerCharCode !== state2.src.charCodeAt(posAfterMarker - 1)) {
        break;
      }
    }
    if (isOrdered) {
      token = state2.push("ordered_list_close", "ol", -1);
    } else {
      token = state2.push("bullet_list_close", "ul", -1);
    }
    token.markup = String.fromCharCode(markerCharCode);
    listLines[1] = nextLine;
    state2.line = nextLine;
    state2.parentType = oldParentType;
    if (tight) {
      markTightParagraphs(state2, listTokIdx);
    }
    return true;
  }
  function reference(state2, startLine, _endLine, silent) {
    let pos = state2.bMarks[startLine] + state2.tShift[startLine];
    let max = state2.eMarks[startLine];
    let nextLine = startLine + 1;
    if (state2.sCount[startLine] - state2.blkIndent >= 4) {
      return false;
    }
    if (state2.src.charCodeAt(pos) !== 91) {
      return false;
    }
    function getNextLine(nextLine2) {
      const endLine = state2.lineMax;
      if (nextLine2 >= endLine || state2.isEmpty(nextLine2)) {
        return null;
      }
      let isContinuation = false;
      if (state2.sCount[nextLine2] - state2.blkIndent > 3) {
        isContinuation = true;
      }
      if (state2.sCount[nextLine2] < 0) {
        isContinuation = true;
      }
      if (!isContinuation) {
        const terminatorRules = state2.md.block.ruler.getRules("reference");
        const oldParentType = state2.parentType;
        state2.parentType = "reference";
        let terminate = false;
        for (let i = 0, l = terminatorRules.length; i < l; i++) {
          if (terminatorRules[i](state2, nextLine2, endLine, true)) {
            terminate = true;
            break;
          }
        }
        state2.parentType = oldParentType;
        if (terminate) {
          return null;
        }
      }
      const pos2 = state2.bMarks[nextLine2] + state2.tShift[nextLine2];
      const max2 = state2.eMarks[nextLine2];
      return state2.src.slice(pos2, max2 + 1);
    }
    let str = state2.src.slice(pos, max + 1);
    max = str.length;
    let labelEnd = -1;
    for (pos = 1; pos < max; pos++) {
      const ch = str.charCodeAt(pos);
      if (ch === 91) {
        return false;
      } else if (ch === 93) {
        labelEnd = pos;
        break;
      } else if (ch === 10) {
        const lineContent = getNextLine(nextLine);
        if (lineContent !== null) {
          str += lineContent;
          max = str.length;
          nextLine++;
        }
      } else if (ch === 92) {
        pos++;
        if (pos < max && str.charCodeAt(pos) === 10) {
          const lineContent = getNextLine(nextLine);
          if (lineContent !== null) {
            str += lineContent;
            max = str.length;
            nextLine++;
          }
        }
      }
    }
    if (labelEnd < 0 || str.charCodeAt(labelEnd + 1) !== 58) {
      return false;
    }
    for (pos = labelEnd + 2; pos < max; pos++) {
      const ch = str.charCodeAt(pos);
      if (ch === 10) {
        const lineContent = getNextLine(nextLine);
        if (lineContent !== null) {
          str += lineContent;
          max = str.length;
          nextLine++;
        }
      } else if (isSpace(ch)) ;
      else {
        break;
      }
    }
    const destRes = state2.md.helpers.parseLinkDestination(str, pos, max);
    if (!destRes.ok) {
      return false;
    }
    const href = state2.md.normalizeLink(destRes.str);
    if (!state2.md.validateLink(href)) {
      return false;
    }
    pos = destRes.pos;
    const destEndPos = pos;
    const destEndLineNo = nextLine;
    const start = pos;
    for (; pos < max; pos++) {
      const ch = str.charCodeAt(pos);
      if (ch === 10) {
        const lineContent = getNextLine(nextLine);
        if (lineContent !== null) {
          str += lineContent;
          max = str.length;
          nextLine++;
        }
      } else if (isSpace(ch)) ;
      else {
        break;
      }
    }
    let titleRes = state2.md.helpers.parseLinkTitle(str, pos, max);
    while (titleRes.can_continue) {
      const lineContent = getNextLine(nextLine);
      if (lineContent === null) break;
      str += lineContent;
      pos = max;
      max = str.length;
      nextLine++;
      titleRes = state2.md.helpers.parseLinkTitle(str, pos, max, titleRes);
    }
    let title;
    if (pos < max && start !== pos && titleRes.ok) {
      title = titleRes.str;
      pos = titleRes.pos;
    } else {
      title = "";
      pos = destEndPos;
      nextLine = destEndLineNo;
    }
    while (pos < max) {
      const ch = str.charCodeAt(pos);
      if (!isSpace(ch)) {
        break;
      }
      pos++;
    }
    if (pos < max && str.charCodeAt(pos) !== 10) {
      if (title) {
        title = "";
        pos = destEndPos;
        nextLine = destEndLineNo;
        while (pos < max) {
          const ch = str.charCodeAt(pos);
          if (!isSpace(ch)) {
            break;
          }
          pos++;
        }
      }
    }
    if (pos < max && str.charCodeAt(pos) !== 10) {
      return false;
    }
    const label = normalizeReference(str.slice(1, labelEnd));
    if (!label) {
      return false;
    }
    if (silent) {
      return true;
    }
    if (typeof state2.env.references === "undefined") {
      state2.env.references = {};
    }
    if (typeof state2.env.references[label] === "undefined") {
      state2.env.references[label] = { title, href };
    }
    state2.line = nextLine;
    return true;
  }
  const block_names = [
    "address",
    "article",
    "aside",
    "base",
    "basefont",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "iframe",
    "legend",
    "li",
    "link",
    "main",
    "menu",
    "menuitem",
    "nav",
    "noframes",
    "ol",
    "optgroup",
    "option",
    "p",
    "param",
    "search",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul"
  ];
  const attr_name = "[a-zA-Z_:][a-zA-Z0-9:._-]*";
  const unquoted = "[^\"'=<>`\\x00-\\x20]+";
  const single_quoted = "'[^']*'";
  const double_quoted = '"[^"]*"';
  const attr_value = "(?:" + unquoted + "|" + single_quoted + "|" + double_quoted + ")";
  const attribute = "(?:\\s+" + attr_name + "(?:\\s*=\\s*" + attr_value + ")?)";
  const open_tag = "<[A-Za-z][A-Za-z0-9\\-]*" + attribute + "*\\s*\\/?>";
  const close_tag = "<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>";
  const comment = "<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->";
  const processing = "<[?][\\s\\S]*?[?]>";
  const declaration = "<![A-Za-z][^>]*>";
  const cdata = "<!\\[CDATA\\[[\\s\\S]*?\\]\\]>";
  const HTML_TAG_RE = new RegExp("^(?:" + open_tag + "|" + close_tag + "|" + comment + "|" + processing + "|" + declaration + "|" + cdata + ")");
  const HTML_OPEN_CLOSE_TAG_RE = new RegExp("^(?:" + open_tag + "|" + close_tag + ")");
  const HTML_SEQUENCES = [
    [/^<(script|pre|style|textarea)(?=(\s|>|$))/i, /<\/(script|pre|style|textarea)>/i, true],
    [/^<!--/, /-->/, true],
    [/^<\?/, /\?>/, true],
    [/^<![A-Z]/, />/, true],
    [/^<!\[CDATA\[/, /\]\]>/, true],
    [new RegExp("^</?(" + block_names.join("|") + ")(?=(\\s|/?>|$))", "i"), /^$/, true],
    [new RegExp(HTML_OPEN_CLOSE_TAG_RE.source + "\\s*$"), /^$/, false]
  ];
  function html_block(state2, startLine, endLine, silent) {
    let pos = state2.bMarks[startLine] + state2.tShift[startLine];
    let max = state2.eMarks[startLine];
    if (state2.sCount[startLine] - state2.blkIndent >= 4) {
      return false;
    }
    if (!state2.md.options.html) {
      return false;
    }
    if (state2.src.charCodeAt(pos) !== 60) {
      return false;
    }
    let lineText = state2.src.slice(pos, max);
    let i = 0;
    for (; i < HTML_SEQUENCES.length; i++) {
      if (HTML_SEQUENCES[i][0].test(lineText)) {
        break;
      }
    }
    if (i === HTML_SEQUENCES.length) {
      return false;
    }
    if (silent) {
      return HTML_SEQUENCES[i][2];
    }
    let nextLine = startLine + 1;
    if (!HTML_SEQUENCES[i][1].test(lineText)) {
      for (; nextLine < endLine; nextLine++) {
        if (state2.sCount[nextLine] < state2.blkIndent) {
          break;
        }
        pos = state2.bMarks[nextLine] + state2.tShift[nextLine];
        max = state2.eMarks[nextLine];
        lineText = state2.src.slice(pos, max);
        if (HTML_SEQUENCES[i][1].test(lineText)) {
          if (lineText.length !== 0) {
            nextLine++;
          }
          break;
        }
      }
    }
    state2.line = nextLine;
    const token = state2.push("html_block", "", 0);
    token.map = [startLine, nextLine];
    token.content = state2.getLines(startLine, nextLine, state2.blkIndent, true);
    return true;
  }
  function heading(state2, startLine, endLine, silent) {
    let pos = state2.bMarks[startLine] + state2.tShift[startLine];
    let max = state2.eMarks[startLine];
    if (state2.sCount[startLine] - state2.blkIndent >= 4) {
      return false;
    }
    let ch = state2.src.charCodeAt(pos);
    if (ch !== 35 || pos >= max) {
      return false;
    }
    let level = 1;
    ch = state2.src.charCodeAt(++pos);
    while (ch === 35 && pos < max && level <= 6) {
      level++;
      ch = state2.src.charCodeAt(++pos);
    }
    if (level > 6 || pos < max && !isSpace(ch)) {
      return false;
    }
    if (silent) {
      return true;
    }
    max = state2.skipSpacesBack(max, pos);
    const tmp = state2.skipCharsBack(max, 35, pos);
    if (tmp > pos && isSpace(state2.src.charCodeAt(tmp - 1))) {
      max = tmp;
    }
    state2.line = startLine + 1;
    const token_o = state2.push("heading_open", "h" + String(level), 1);
    token_o.markup = "########".slice(0, level);
    token_o.map = [startLine, state2.line];
    const token_i = state2.push("inline", "", 0);
    token_i.content = state2.src.slice(pos, max).trim();
    token_i.map = [startLine, state2.line];
    token_i.children = [];
    const token_c = state2.push("heading_close", "h" + String(level), -1);
    token_c.markup = "########".slice(0, level);
    return true;
  }
  function lheading(state2, startLine, endLine) {
    const terminatorRules = state2.md.block.ruler.getRules("paragraph");
    if (state2.sCount[startLine] - state2.blkIndent >= 4) {
      return false;
    }
    const oldParentType = state2.parentType;
    state2.parentType = "paragraph";
    let level = 0;
    let marker;
    let nextLine = startLine + 1;
    for (; nextLine < endLine && !state2.isEmpty(nextLine); nextLine++) {
      if (state2.sCount[nextLine] - state2.blkIndent > 3) {
        continue;
      }
      if (state2.sCount[nextLine] >= state2.blkIndent) {
        let pos = state2.bMarks[nextLine] + state2.tShift[nextLine];
        const max = state2.eMarks[nextLine];
        if (pos < max) {
          marker = state2.src.charCodeAt(pos);
          if (marker === 45 || marker === 61) {
            pos = state2.skipChars(pos, marker);
            pos = state2.skipSpaces(pos);
            if (pos >= max) {
              level = marker === 61 ? 1 : 2;
              break;
            }
          }
        }
      }
      if (state2.sCount[nextLine] < 0) {
        continue;
      }
      let terminate = false;
      for (let i = 0, l = terminatorRules.length; i < l; i++) {
        if (terminatorRules[i](state2, nextLine, endLine, true)) {
          terminate = true;
          break;
        }
      }
      if (terminate) {
        break;
      }
    }
    if (!level) {
      return false;
    }
    const content = state2.getLines(startLine, nextLine, state2.blkIndent, false).trim();
    state2.line = nextLine + 1;
    const token_o = state2.push("heading_open", "h" + String(level), 1);
    token_o.markup = String.fromCharCode(marker);
    token_o.map = [startLine, state2.line];
    const token_i = state2.push("inline", "", 0);
    token_i.content = content;
    token_i.map = [startLine, state2.line - 1];
    token_i.children = [];
    const token_c = state2.push("heading_close", "h" + String(level), -1);
    token_c.markup = String.fromCharCode(marker);
    state2.parentType = oldParentType;
    return true;
  }
  function paragraph(state2, startLine, endLine) {
    const terminatorRules = state2.md.block.ruler.getRules("paragraph");
    const oldParentType = state2.parentType;
    let nextLine = startLine + 1;
    state2.parentType = "paragraph";
    for (; nextLine < endLine && !state2.isEmpty(nextLine); nextLine++) {
      if (state2.sCount[nextLine] - state2.blkIndent > 3) {
        continue;
      }
      if (state2.sCount[nextLine] < 0) {
        continue;
      }
      let terminate = false;
      for (let i = 0, l = terminatorRules.length; i < l; i++) {
        if (terminatorRules[i](state2, nextLine, endLine, true)) {
          terminate = true;
          break;
        }
      }
      if (terminate) {
        break;
      }
    }
    const content = state2.getLines(startLine, nextLine, state2.blkIndent, false).trim();
    state2.line = nextLine;
    const token_o = state2.push("paragraph_open", "p", 1);
    token_o.map = [startLine, state2.line];
    const token_i = state2.push("inline", "", 0);
    token_i.content = content;
    token_i.map = [startLine, state2.line];
    token_i.children = [];
    state2.push("paragraph_close", "p", -1);
    state2.parentType = oldParentType;
    return true;
  }
  const _rules$1 = [

["table", table, ["paragraph", "reference"]],
    ["code", code],
    ["fence", fence, ["paragraph", "reference", "blockquote", "list"]],
    ["blockquote", blockquote, ["paragraph", "reference", "blockquote", "list"]],
    ["hr", hr, ["paragraph", "reference", "blockquote", "list"]],
    ["list", list, ["paragraph", "reference", "blockquote"]],
    ["reference", reference],
    ["html_block", html_block, ["paragraph", "reference", "blockquote"]],
    ["heading", heading, ["paragraph", "reference", "blockquote"]],
    ["lheading", lheading],
    ["paragraph", paragraph]
  ];
  function ParserBlock() {
    this.ruler = new Ruler();
    for (let i = 0; i < _rules$1.length; i++) {
      this.ruler.push(_rules$1[i][0], _rules$1[i][1], { alt: (_rules$1[i][2] || []).slice() });
    }
  }
  ParserBlock.prototype.tokenize = function(state2, startLine, endLine) {
    const rules = this.ruler.getRules("");
    const len = rules.length;
    const maxNesting = state2.md.options.maxNesting;
    let line = startLine;
    let hasEmptyLines = false;
    while (line < endLine) {
      state2.line = line = state2.skipEmptyLines(line);
      if (line >= endLine) {
        break;
      }
      if (state2.sCount[line] < state2.blkIndent) {
        break;
      }
      if (state2.level >= maxNesting) {
        state2.line = endLine;
        break;
      }
      const prevLine = state2.line;
      let ok = false;
      for (let i = 0; i < len; i++) {
        ok = rules[i](state2, line, endLine, false);
        if (ok) {
          if (prevLine >= state2.line) {
            throw new Error("block rule didn't increment state.line");
          }
          break;
        }
      }
      if (!ok) throw new Error("none of the block rules matched");
      state2.tight = !hasEmptyLines;
      if (state2.isEmpty(state2.line - 1)) {
        hasEmptyLines = true;
      }
      line = state2.line;
      if (line < endLine && state2.isEmpty(line)) {
        hasEmptyLines = true;
        line++;
        state2.line = line;
      }
    }
  };
  ParserBlock.prototype.parse = function(src, md, env, outTokens) {
    if (!src) {
      return;
    }
    const state2 = new this.State(src, md, env, outTokens);
    this.tokenize(state2, state2.line, state2.lineMax);
  };
  ParserBlock.prototype.State = StateBlock;
  function StateInline(src, md, env, outTokens) {
    this.src = src;
    this.env = env;
    this.md = md;
    this.tokens = outTokens;
    this.tokens_meta = Array(outTokens.length);
    this.pos = 0;
    this.posMax = this.src.length;
    this.level = 0;
    this.pending = "";
    this.pendingLevel = 0;
    this.cache = {};
    this.delimiters = [];
    this._prev_delimiters = [];
    this.backticks = {};
    this.backticksScanned = false;
    this.linkLevel = 0;
  }
  StateInline.prototype.pushPending = function() {
    const token = new Token("text", "", 0);
    token.content = this.pending;
    token.level = this.pendingLevel;
    this.tokens.push(token);
    this.pending = "";
    return token;
  };
  StateInline.prototype.push = function(type, tag, nesting) {
    if (this.pending) {
      this.pushPending();
    }
    const token = new Token(type, tag, nesting);
    let token_meta = null;
    if (nesting < 0) {
      this.level--;
      this.delimiters = this._prev_delimiters.pop();
    }
    token.level = this.level;
    if (nesting > 0) {
      this.level++;
      this._prev_delimiters.push(this.delimiters);
      this.delimiters = [];
      token_meta = { delimiters: this.delimiters };
    }
    this.pendingLevel = this.level;
    this.tokens.push(token);
    this.tokens_meta.push(token_meta);
    return token;
  };
  StateInline.prototype.scanDelims = function(start, canSplitWord) {
    const max = this.posMax;
    const marker = this.src.charCodeAt(start);
    const lastChar = start > 0 ? this.src.charCodeAt(start - 1) : 32;
    let pos = start;
    while (pos < max && this.src.charCodeAt(pos) === marker) {
      pos++;
    }
    const count = pos - start;
    const nextChar = pos < max ? this.src.charCodeAt(pos) : 32;
    const isLastPunctChar = isMdAsciiPunct(lastChar) || isPunctChar(String.fromCharCode(lastChar));
    const isNextPunctChar = isMdAsciiPunct(nextChar) || isPunctChar(String.fromCharCode(nextChar));
    const isLastWhiteSpace = isWhiteSpace(lastChar);
    const isNextWhiteSpace = isWhiteSpace(nextChar);
    const left_flanking = !isNextWhiteSpace && (!isNextPunctChar || isLastWhiteSpace || isLastPunctChar);
    const right_flanking = !isLastWhiteSpace && (!isLastPunctChar || isNextWhiteSpace || isNextPunctChar);
    const can_open = left_flanking && (canSplitWord || !right_flanking || isLastPunctChar);
    const can_close = right_flanking && (canSplitWord || !left_flanking || isNextPunctChar);
    return { can_open, can_close, length: count };
  };
  StateInline.prototype.Token = Token;
  function isTerminatorChar(ch) {
    switch (ch) {
      case 10:
      case 33:
      case 35:
      case 36:
      case 37:
      case 38:
      case 42:
      case 43:
      case 45:
      case 58:
      case 60:
      case 61:
      case 62:
      case 64:
      case 91:
      case 92:
      case 93:
      case 94:
      case 95:
      case 96:
      case 123:
      case 125:
      case 126:
        return true;
      default:
        return false;
    }
  }
  function text(state2, silent) {
    let pos = state2.pos;
    while (pos < state2.posMax && !isTerminatorChar(state2.src.charCodeAt(pos))) {
      pos++;
    }
    if (pos === state2.pos) {
      return false;
    }
    if (!silent) {
      state2.pending += state2.src.slice(state2.pos, pos);
    }
    state2.pos = pos;
    return true;
  }
  const SCHEME_RE = /(?:^|[^a-z0-9.+-])([a-z][a-z0-9.+-]*)$/i;
  function linkify(state2, silent) {
    if (!state2.md.options.linkify) return false;
    if (state2.linkLevel > 0) return false;
    const pos = state2.pos;
    const max = state2.posMax;
    if (pos + 3 > max) return false;
    if (state2.src.charCodeAt(pos) !== 58) return false;
    if (state2.src.charCodeAt(pos + 1) !== 47) return false;
    if (state2.src.charCodeAt(pos + 2) !== 47) return false;
    const match2 = state2.pending.match(SCHEME_RE);
    if (!match2) return false;
    const proto = match2[1];
    const link2 = state2.md.linkify.matchAtStart(state2.src.slice(pos - proto.length));
    if (!link2) return false;
    let url = link2.url;
    if (url.length <= proto.length) return false;
    let urlEnd = url.length;
    while (urlEnd > 0 && url.charCodeAt(urlEnd - 1) === 42) {
      urlEnd--;
    }
    if (urlEnd !== url.length) {
      url = url.slice(0, urlEnd);
    }
    const fullUrl = state2.md.normalizeLink(url);
    if (!state2.md.validateLink(fullUrl)) return false;
    if (!silent) {
      state2.pending = state2.pending.slice(0, -proto.length);
      const token_o = state2.push("link_open", "a", 1);
      token_o.attrs = [["href", fullUrl]];
      token_o.markup = "linkify";
      token_o.info = "auto";
      const token_t = state2.push("text", "", 0);
      token_t.content = state2.md.normalizeLinkText(url);
      const token_c = state2.push("link_close", "a", -1);
      token_c.markup = "linkify";
      token_c.info = "auto";
    }
    state2.pos += url.length - proto.length;
    return true;
  }
  function newline(state2, silent) {
    let pos = state2.pos;
    if (state2.src.charCodeAt(pos) !== 10) {
      return false;
    }
    const pmax = state2.pending.length - 1;
    const max = state2.posMax;
    if (!silent) {
      if (pmax >= 0 && state2.pending.charCodeAt(pmax) === 32) {
        if (pmax >= 1 && state2.pending.charCodeAt(pmax - 1) === 32) {
          let ws = pmax - 1;
          while (ws >= 1 && state2.pending.charCodeAt(ws - 1) === 32) ws--;
          state2.pending = state2.pending.slice(0, ws);
          state2.push("hardbreak", "br", 0);
        } else {
          state2.pending = state2.pending.slice(0, -1);
          state2.push("softbreak", "br", 0);
        }
      } else {
        state2.push("softbreak", "br", 0);
      }
    }
    pos++;
    while (pos < max && isSpace(state2.src.charCodeAt(pos))) {
      pos++;
    }
    state2.pos = pos;
    return true;
  }
  const ESCAPED = [];
  for (let i = 0; i < 256; i++) {
    ESCAPED.push(0);
  }
  "\\!\"#$%&'()*+,./:;<=>?@[]^_`{|}~-".split("").forEach(function(ch) {
    ESCAPED[ch.charCodeAt(0)] = 1;
  });
  function escape(state2, silent) {
    let pos = state2.pos;
    const max = state2.posMax;
    if (state2.src.charCodeAt(pos) !== 92) return false;
    pos++;
    if (pos >= max) return false;
    let ch1 = state2.src.charCodeAt(pos);
    if (ch1 === 10) {
      if (!silent) {
        state2.push("hardbreak", "br", 0);
      }
      pos++;
      while (pos < max) {
        ch1 = state2.src.charCodeAt(pos);
        if (!isSpace(ch1)) break;
        pos++;
      }
      state2.pos = pos;
      return true;
    }
    let escapedStr = state2.src[pos];
    if (ch1 >= 55296 && ch1 <= 56319 && pos + 1 < max) {
      const ch2 = state2.src.charCodeAt(pos + 1);
      if (ch2 >= 56320 && ch2 <= 57343) {
        escapedStr += state2.src[pos + 1];
        pos++;
      }
    }
    const origStr = "\\" + escapedStr;
    if (!silent) {
      const token = state2.push("text_special", "", 0);
      if (ch1 < 256 && ESCAPED[ch1] !== 0) {
        token.content = escapedStr;
      } else {
        token.content = origStr;
      }
      token.markup = origStr;
      token.info = "escape";
    }
    state2.pos = pos + 1;
    return true;
  }
  function backtick(state2, silent) {
    let pos = state2.pos;
    const ch = state2.src.charCodeAt(pos);
    if (ch !== 96) {
      return false;
    }
    const start = pos;
    pos++;
    const max = state2.posMax;
    while (pos < max && state2.src.charCodeAt(pos) === 96) {
      pos++;
    }
    const marker = state2.src.slice(start, pos);
    const openerLength = marker.length;
    if (state2.backticksScanned && (state2.backticks[openerLength] || 0) <= start) {
      if (!silent) state2.pending += marker;
      state2.pos += openerLength;
      return true;
    }
    let matchEnd = pos;
    let matchStart;
    while ((matchStart = state2.src.indexOf("`", matchEnd)) !== -1) {
      matchEnd = matchStart + 1;
      while (matchEnd < max && state2.src.charCodeAt(matchEnd) === 96) {
        matchEnd++;
      }
      const closerLength = matchEnd - matchStart;
      if (closerLength === openerLength) {
        if (!silent) {
          const token = state2.push("code_inline", "code", 0);
          token.markup = marker;
          token.content = state2.src.slice(pos, matchStart).replace(/\n/g, " ").replace(/^ (.+) $/, "$1");
        }
        state2.pos = matchEnd;
        return true;
      }
      state2.backticks[closerLength] = matchStart;
    }
    state2.backticksScanned = true;
    if (!silent) state2.pending += marker;
    state2.pos += openerLength;
    return true;
  }
  function strikethrough_tokenize(state2, silent) {
    const start = state2.pos;
    const marker = state2.src.charCodeAt(start);
    if (silent) {
      return false;
    }
    if (marker !== 126) {
      return false;
    }
    const scanned = state2.scanDelims(state2.pos, true);
    let len = scanned.length;
    const ch = String.fromCharCode(marker);
    if (len < 2) {
      return false;
    }
    let token;
    if (len % 2) {
      token = state2.push("text", "", 0);
      token.content = ch;
      len--;
    }
    for (let i = 0; i < len; i += 2) {
      token = state2.push("text", "", 0);
      token.content = ch + ch;
      state2.delimiters.push({
        marker,
        length: 0,
token: state2.tokens.length - 1,
        end: -1,
        open: scanned.can_open,
        close: scanned.can_close
      });
    }
    state2.pos += scanned.length;
    return true;
  }
  function postProcess$1(state2, delimiters) {
    let token;
    const loneMarkers = [];
    const max = delimiters.length;
    for (let i = 0; i < max; i++) {
      const startDelim = delimiters[i];
      if (startDelim.marker !== 126) {
        continue;
      }
      if (startDelim.end === -1) {
        continue;
      }
      const endDelim = delimiters[startDelim.end];
      token = state2.tokens[startDelim.token];
      token.type = "s_open";
      token.tag = "s";
      token.nesting = 1;
      token.markup = "~~";
      token.content = "";
      token = state2.tokens[endDelim.token];
      token.type = "s_close";
      token.tag = "s";
      token.nesting = -1;
      token.markup = "~~";
      token.content = "";
      if (state2.tokens[endDelim.token - 1].type === "text" && state2.tokens[endDelim.token - 1].content === "~") {
        loneMarkers.push(endDelim.token - 1);
      }
    }
    while (loneMarkers.length) {
      const i = loneMarkers.pop();
      let j = i + 1;
      while (j < state2.tokens.length && state2.tokens[j].type === "s_close") {
        j++;
      }
      j--;
      if (i !== j) {
        token = state2.tokens[j];
        state2.tokens[j] = state2.tokens[i];
        state2.tokens[i] = token;
      }
    }
  }
  function strikethrough_postProcess(state2) {
    const tokens_meta = state2.tokens_meta;
    const max = state2.tokens_meta.length;
    postProcess$1(state2, state2.delimiters);
    for (let curr = 0; curr < max; curr++) {
      if (tokens_meta[curr] && tokens_meta[curr].delimiters) {
        postProcess$1(state2, tokens_meta[curr].delimiters);
      }
    }
  }
  const r_strikethrough = {
    tokenize: strikethrough_tokenize,
    postProcess: strikethrough_postProcess
  };
  function emphasis_tokenize(state2, silent) {
    const start = state2.pos;
    const marker = state2.src.charCodeAt(start);
    if (silent) {
      return false;
    }
    if (marker !== 95 && marker !== 42) {
      return false;
    }
    const scanned = state2.scanDelims(state2.pos, marker === 42);
    for (let i = 0; i < scanned.length; i++) {
      const token = state2.push("text", "", 0);
      token.content = String.fromCharCode(marker);
      state2.delimiters.push({

marker,

length: scanned.length,

token: state2.tokens.length - 1,


end: -1,


open: scanned.can_open,
        close: scanned.can_close
      });
    }
    state2.pos += scanned.length;
    return true;
  }
  function postProcess(state2, delimiters) {
    const max = delimiters.length;
    for (let i = max - 1; i >= 0; i--) {
      const startDelim = delimiters[i];
      if (startDelim.marker !== 95 && startDelim.marker !== 42) {
        continue;
      }
      if (startDelim.end === -1) {
        continue;
      }
      const endDelim = delimiters[startDelim.end];
      const isStrong = i > 0 && delimiters[i - 1].end === startDelim.end + 1 &&
delimiters[i - 1].marker === startDelim.marker && delimiters[i - 1].token === startDelim.token - 1 &&
delimiters[startDelim.end + 1].token === endDelim.token + 1;
      const ch = String.fromCharCode(startDelim.marker);
      const token_o = state2.tokens[startDelim.token];
      token_o.type = isStrong ? "strong_open" : "em_open";
      token_o.tag = isStrong ? "strong" : "em";
      token_o.nesting = 1;
      token_o.markup = isStrong ? ch + ch : ch;
      token_o.content = "";
      const token_c = state2.tokens[endDelim.token];
      token_c.type = isStrong ? "strong_close" : "em_close";
      token_c.tag = isStrong ? "strong" : "em";
      token_c.nesting = -1;
      token_c.markup = isStrong ? ch + ch : ch;
      token_c.content = "";
      if (isStrong) {
        state2.tokens[delimiters[i - 1].token].content = "";
        state2.tokens[delimiters[startDelim.end + 1].token].content = "";
        i--;
      }
    }
  }
  function emphasis_post_process(state2) {
    const tokens_meta = state2.tokens_meta;
    const max = state2.tokens_meta.length;
    postProcess(state2, state2.delimiters);
    for (let curr = 0; curr < max; curr++) {
      if (tokens_meta[curr] && tokens_meta[curr].delimiters) {
        postProcess(state2, tokens_meta[curr].delimiters);
      }
    }
  }
  const r_emphasis = {
    tokenize: emphasis_tokenize,
    postProcess: emphasis_post_process
  };
  function link(state2, silent) {
    let code2, label, res, ref;
    let href = "";
    let title = "";
    let start = state2.pos;
    let parseReference = true;
    if (state2.src.charCodeAt(state2.pos) !== 91) {
      return false;
    }
    const oldPos = state2.pos;
    const max = state2.posMax;
    const labelStart = state2.pos + 1;
    const labelEnd = state2.md.helpers.parseLinkLabel(state2, state2.pos, true);
    if (labelEnd < 0) {
      return false;
    }
    let pos = labelEnd + 1;
    if (pos < max && state2.src.charCodeAt(pos) === 40) {
      parseReference = false;
      pos++;
      for (; pos < max; pos++) {
        code2 = state2.src.charCodeAt(pos);
        if (!isSpace(code2) && code2 !== 10) {
          break;
        }
      }
      if (pos >= max) {
        return false;
      }
      start = pos;
      res = state2.md.helpers.parseLinkDestination(state2.src, pos, state2.posMax);
      if (res.ok) {
        href = state2.md.normalizeLink(res.str);
        if (state2.md.validateLink(href)) {
          pos = res.pos;
        } else {
          href = "";
        }
        start = pos;
        for (; pos < max; pos++) {
          code2 = state2.src.charCodeAt(pos);
          if (!isSpace(code2) && code2 !== 10) {
            break;
          }
        }
        res = state2.md.helpers.parseLinkTitle(state2.src, pos, state2.posMax);
        if (pos < max && start !== pos && res.ok) {
          title = res.str;
          pos = res.pos;
          for (; pos < max; pos++) {
            code2 = state2.src.charCodeAt(pos);
            if (!isSpace(code2) && code2 !== 10) {
              break;
            }
          }
        }
      }
      if (pos >= max || state2.src.charCodeAt(pos) !== 41) {
        parseReference = true;
      }
      pos++;
    }
    if (parseReference) {
      if (typeof state2.env.references === "undefined") {
        return false;
      }
      if (pos < max && state2.src.charCodeAt(pos) === 91) {
        start = pos + 1;
        pos = state2.md.helpers.parseLinkLabel(state2, pos);
        if (pos >= 0) {
          label = state2.src.slice(start, pos++);
        } else {
          pos = labelEnd + 1;
        }
      } else {
        pos = labelEnd + 1;
      }
      if (!label) {
        label = state2.src.slice(labelStart, labelEnd);
      }
      ref = state2.env.references[normalizeReference(label)];
      if (!ref) {
        state2.pos = oldPos;
        return false;
      }
      href = ref.href;
      title = ref.title;
    }
    if (!silent) {
      state2.pos = labelStart;
      state2.posMax = labelEnd;
      const token_o = state2.push("link_open", "a", 1);
      const attrs = [["href", href]];
      token_o.attrs = attrs;
      if (title) {
        attrs.push(["title", title]);
      }
      state2.linkLevel++;
      state2.md.inline.tokenize(state2);
      state2.linkLevel--;
      state2.push("link_close", "a", -1);
    }
    state2.pos = pos;
    state2.posMax = max;
    return true;
  }
  function image(state2, silent) {
    let code2, content, label, pos, ref, res, title, start;
    let href = "";
    const oldPos = state2.pos;
    const max = state2.posMax;
    if (state2.src.charCodeAt(state2.pos) !== 33) {
      return false;
    }
    if (state2.src.charCodeAt(state2.pos + 1) !== 91) {
      return false;
    }
    const labelStart = state2.pos + 2;
    const labelEnd = state2.md.helpers.parseLinkLabel(state2, state2.pos + 1, false);
    if (labelEnd < 0) {
      return false;
    }
    pos = labelEnd + 1;
    if (pos < max && state2.src.charCodeAt(pos) === 40) {
      pos++;
      for (; pos < max; pos++) {
        code2 = state2.src.charCodeAt(pos);
        if (!isSpace(code2) && code2 !== 10) {
          break;
        }
      }
      if (pos >= max) {
        return false;
      }
      start = pos;
      res = state2.md.helpers.parseLinkDestination(state2.src, pos, state2.posMax);
      if (res.ok) {
        href = state2.md.normalizeLink(res.str);
        if (state2.md.validateLink(href)) {
          pos = res.pos;
        } else {
          href = "";
        }
      }
      start = pos;
      for (; pos < max; pos++) {
        code2 = state2.src.charCodeAt(pos);
        if (!isSpace(code2) && code2 !== 10) {
          break;
        }
      }
      res = state2.md.helpers.parseLinkTitle(state2.src, pos, state2.posMax);
      if (pos < max && start !== pos && res.ok) {
        title = res.str;
        pos = res.pos;
        for (; pos < max; pos++) {
          code2 = state2.src.charCodeAt(pos);
          if (!isSpace(code2) && code2 !== 10) {
            break;
          }
        }
      } else {
        title = "";
      }
      if (pos >= max || state2.src.charCodeAt(pos) !== 41) {
        state2.pos = oldPos;
        return false;
      }
      pos++;
    } else {
      if (typeof state2.env.references === "undefined") {
        return false;
      }
      if (pos < max && state2.src.charCodeAt(pos) === 91) {
        start = pos + 1;
        pos = state2.md.helpers.parseLinkLabel(state2, pos);
        if (pos >= 0) {
          label = state2.src.slice(start, pos++);
        } else {
          pos = labelEnd + 1;
        }
      } else {
        pos = labelEnd + 1;
      }
      if (!label) {
        label = state2.src.slice(labelStart, labelEnd);
      }
      ref = state2.env.references[normalizeReference(label)];
      if (!ref) {
        state2.pos = oldPos;
        return false;
      }
      href = ref.href;
      title = ref.title;
    }
    if (!silent) {
      content = state2.src.slice(labelStart, labelEnd);
      const tokens = [];
      state2.md.inline.parse(
        content,
        state2.md,
        state2.env,
        tokens
      );
      const token = state2.push("image", "img", 0);
      const attrs = [["src", href], ["alt", ""]];
      token.attrs = attrs;
      token.children = tokens;
      token.content = content;
      if (title) {
        attrs.push(["title", title]);
      }
    }
    state2.pos = pos;
    state2.posMax = max;
    return true;
  }
  const EMAIL_RE = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/;
  const AUTOLINK_RE = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;
  function autolink(state2, silent) {
    let pos = state2.pos;
    if (state2.src.charCodeAt(pos) !== 60) {
      return false;
    }
    const start = state2.pos;
    const max = state2.posMax;
    for (; ; ) {
      if (++pos >= max) return false;
      const ch = state2.src.charCodeAt(pos);
      if (ch === 60) return false;
      if (ch === 62) break;
    }
    const url = state2.src.slice(start + 1, pos);
    if (AUTOLINK_RE.test(url)) {
      const fullUrl = state2.md.normalizeLink(url);
      if (!state2.md.validateLink(fullUrl)) {
        return false;
      }
      if (!silent) {
        const token_o = state2.push("link_open", "a", 1);
        token_o.attrs = [["href", fullUrl]];
        token_o.markup = "autolink";
        token_o.info = "auto";
        const token_t = state2.push("text", "", 0);
        token_t.content = state2.md.normalizeLinkText(url);
        const token_c = state2.push("link_close", "a", -1);
        token_c.markup = "autolink";
        token_c.info = "auto";
      }
      state2.pos += url.length + 2;
      return true;
    }
    if (EMAIL_RE.test(url)) {
      const fullUrl = state2.md.normalizeLink("mailto:" + url);
      if (!state2.md.validateLink(fullUrl)) {
        return false;
      }
      if (!silent) {
        const token_o = state2.push("link_open", "a", 1);
        token_o.attrs = [["href", fullUrl]];
        token_o.markup = "autolink";
        token_o.info = "auto";
        const token_t = state2.push("text", "", 0);
        token_t.content = state2.md.normalizeLinkText(url);
        const token_c = state2.push("link_close", "a", -1);
        token_c.markup = "autolink";
        token_c.info = "auto";
      }
      state2.pos += url.length + 2;
      return true;
    }
    return false;
  }
  function isLinkOpen(str) {
    return /^<a[>\s]/i.test(str);
  }
  function isLinkClose(str) {
    return /^<\/a\s*>/i.test(str);
  }
  function isLetter(ch) {
    const lc = ch | 32;
    return lc >= 97 && lc <= 122;
  }
  function html_inline(state2, silent) {
    if (!state2.md.options.html) {
      return false;
    }
    const max = state2.posMax;
    const pos = state2.pos;
    if (state2.src.charCodeAt(pos) !== 60 || pos + 2 >= max) {
      return false;
    }
    const ch = state2.src.charCodeAt(pos + 1);
    if (ch !== 33 && ch !== 63 && ch !== 47 && !isLetter(ch)) {
      return false;
    }
    const match2 = state2.src.slice(pos).match(HTML_TAG_RE);
    if (!match2) {
      return false;
    }
    if (!silent) {
      const token = state2.push("html_inline", "", 0);
      token.content = match2[0];
      if (isLinkOpen(token.content)) state2.linkLevel++;
      if (isLinkClose(token.content)) state2.linkLevel--;
    }
    state2.pos += match2[0].length;
    return true;
  }
  const DIGITAL_RE = /^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i;
  const NAMED_RE = /^&([a-z][a-z0-9]{1,31});/i;
  function entity(state2, silent) {
    const pos = state2.pos;
    const max = state2.posMax;
    if (state2.src.charCodeAt(pos) !== 38) return false;
    if (pos + 1 >= max) return false;
    const ch = state2.src.charCodeAt(pos + 1);
    if (ch === 35) {
      const match2 = state2.src.slice(pos).match(DIGITAL_RE);
      if (match2) {
        if (!silent) {
          const code2 = match2[1][0].toLowerCase() === "x" ? parseInt(match2[1].slice(1), 16) : parseInt(match2[1], 10);
          const token = state2.push("text_special", "", 0);
          token.content = isValidEntityCode(code2) ? fromCodePoint(code2) : fromCodePoint(65533);
          token.markup = match2[0];
          token.info = "entity";
        }
        state2.pos += match2[0].length;
        return true;
      }
    } else {
      const match2 = state2.src.slice(pos).match(NAMED_RE);
      if (match2) {
        const decoded = decodeHTML(match2[0]);
        if (decoded !== match2[0]) {
          if (!silent) {
            const token = state2.push("text_special", "", 0);
            token.content = decoded;
            token.markup = match2[0];
            token.info = "entity";
          }
          state2.pos += match2[0].length;
          return true;
        }
      }
    }
    return false;
  }
  function processDelimiters(delimiters) {
    const openersBottom = {};
    const max = delimiters.length;
    if (!max) return;
    let headerIdx = 0;
    let lastTokenIdx = -2;
    const jumps = [];
    for (let closerIdx = 0; closerIdx < max; closerIdx++) {
      const closer = delimiters[closerIdx];
      jumps.push(0);
      if (delimiters[headerIdx].marker !== closer.marker || lastTokenIdx !== closer.token - 1) {
        headerIdx = closerIdx;
      }
      lastTokenIdx = closer.token;
      closer.length = closer.length || 0;
      if (!closer.close) continue;
      if (!openersBottom.hasOwnProperty(closer.marker)) {
        openersBottom[closer.marker] = [-1, -1, -1, -1, -1, -1];
      }
      const minOpenerIdx = openersBottom[closer.marker][(closer.open ? 3 : 0) + closer.length % 3];
      let openerIdx = headerIdx - jumps[headerIdx] - 1;
      let newMinOpenerIdx = openerIdx;
      for (; openerIdx > minOpenerIdx; openerIdx -= jumps[openerIdx] + 1) {
        const opener = delimiters[openerIdx];
        if (opener.marker !== closer.marker) continue;
        if (opener.open && opener.end < 0) {
          let isOddMatch = false;
          if (opener.close || closer.open) {
            if ((opener.length + closer.length) % 3 === 0) {
              if (opener.length % 3 !== 0 || closer.length % 3 !== 0) {
                isOddMatch = true;
              }
            }
          }
          if (!isOddMatch) {
            const lastJump = openerIdx > 0 && !delimiters[openerIdx - 1].open ? jumps[openerIdx - 1] + 1 : 0;
            jumps[closerIdx] = closerIdx - openerIdx + lastJump;
            jumps[openerIdx] = lastJump;
            closer.open = false;
            opener.end = closerIdx;
            opener.close = false;
            newMinOpenerIdx = -1;
            lastTokenIdx = -2;
            break;
          }
        }
      }
      if (newMinOpenerIdx !== -1) {
        openersBottom[closer.marker][(closer.open ? 3 : 0) + (closer.length || 0) % 3] = newMinOpenerIdx;
      }
    }
  }
  function link_pairs(state2) {
    const tokens_meta = state2.tokens_meta;
    const max = state2.tokens_meta.length;
    processDelimiters(state2.delimiters);
    for (let curr = 0; curr < max; curr++) {
      if (tokens_meta[curr] && tokens_meta[curr].delimiters) {
        processDelimiters(tokens_meta[curr].delimiters);
      }
    }
  }
  function fragments_join(state2) {
    let curr, last;
    let level = 0;
    const tokens = state2.tokens;
    const max = state2.tokens.length;
    for (curr = last = 0; curr < max; curr++) {
      if (tokens[curr].nesting < 0) level--;
      tokens[curr].level = level;
      if (tokens[curr].nesting > 0) level++;
      if (tokens[curr].type === "text" && curr + 1 < max && tokens[curr + 1].type === "text") {
        tokens[curr + 1].content = tokens[curr].content + tokens[curr + 1].content;
      } else {
        if (curr !== last) {
          tokens[last] = tokens[curr];
        }
        last++;
      }
    }
    if (curr !== last) {
      tokens.length = last;
    }
  }
  const _rules = [
    ["text", text],
    ["linkify", linkify],
    ["newline", newline],
    ["escape", escape],
    ["backticks", backtick],
    ["strikethrough", r_strikethrough.tokenize],
    ["emphasis", r_emphasis.tokenize],
    ["link", link],
    ["image", image],
    ["autolink", autolink],
    ["html_inline", html_inline],
    ["entity", entity]
  ];
  const _rules2 = [
    ["balance_pairs", link_pairs],
    ["strikethrough", r_strikethrough.postProcess],
    ["emphasis", r_emphasis.postProcess],

["fragments_join", fragments_join]
  ];
  function ParserInline() {
    this.ruler = new Ruler();
    for (let i = 0; i < _rules.length; i++) {
      this.ruler.push(_rules[i][0], _rules[i][1]);
    }
    this.ruler2 = new Ruler();
    for (let i = 0; i < _rules2.length; i++) {
      this.ruler2.push(_rules2[i][0], _rules2[i][1]);
    }
  }
  ParserInline.prototype.skipToken = function(state2) {
    const pos = state2.pos;
    const rules = this.ruler.getRules("");
    const len = rules.length;
    const maxNesting = state2.md.options.maxNesting;
    const cache = state2.cache;
    if (typeof cache[pos] !== "undefined") {
      state2.pos = cache[pos];
      return;
    }
    let ok = false;
    if (state2.level < maxNesting) {
      for (let i = 0; i < len; i++) {
        state2.level++;
        ok = rules[i](state2, true);
        state2.level--;
        if (ok) {
          if (pos >= state2.pos) {
            throw new Error("inline rule didn't increment state.pos");
          }
          break;
        }
      }
    } else {
      state2.pos = state2.posMax;
    }
    if (!ok) {
      state2.pos++;
    }
    cache[pos] = state2.pos;
  };
  ParserInline.prototype.tokenize = function(state2) {
    const rules = this.ruler.getRules("");
    const len = rules.length;
    const end = state2.posMax;
    const maxNesting = state2.md.options.maxNesting;
    while (state2.pos < end) {
      const prevPos = state2.pos;
      let ok = false;
      if (state2.level < maxNesting) {
        for (let i = 0; i < len; i++) {
          ok = rules[i](state2, false);
          if (ok) {
            if (prevPos >= state2.pos) {
              throw new Error("inline rule didn't increment state.pos");
            }
            break;
          }
        }
      }
      if (ok) {
        if (state2.pos >= end) {
          break;
        }
        continue;
      }
      state2.pending += state2.src[state2.pos++];
    }
    if (state2.pending) {
      state2.pushPending();
    }
  };
  ParserInline.prototype.parse = function(str, md, env, outTokens) {
    const state2 = new this.State(str, md, env, outTokens);
    this.tokenize(state2);
    const rules = this.ruler2.getRules("");
    const len = rules.length;
    for (let i = 0; i < len; i++) {
      rules[i](state2);
    }
  };
  ParserInline.prototype.State = StateInline;
  function reFactory(opts) {
    const re = {};
    opts = opts || {};
    re.src_Any = Any.source;
    re.src_Cc = Cc.source;
    re.src_Z = Z.source;
    re.src_P = P.source;
    re.src_ZPCc = [re.src_Z, re.src_P, re.src_Cc].join("|");
    re.src_ZCc = [re.src_Z, re.src_Cc].join("|");
    const text_separators = "[><｜]";
    re.src_pseudo_letter = "(?:(?!" + text_separators + "|" + re.src_ZPCc + ")" + re.src_Any + ")";
    re.src_ip4 = "(?:(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)";
    re.src_auth = "(?:(?:(?!" + re.src_ZCc + "|[@/\\[\\]()]).)+@)?";
    re.src_port = "(?::(?:6(?:[0-4]\\d{3}|5(?:[0-4]\\d{2}|5(?:[0-2]\\d|3[0-5])))|[1-5]?\\d{1,4}))?";
    re.src_host_terminator = "(?=$|" + text_separators + "|" + re.src_ZPCc + ")(?!" + (opts["---"] ? "-(?!--)|" : "-|") + "_|:\\d|\\.-|\\.(?!$|" + re.src_ZPCc + "))";
    re.src_path = "(?:[/?#](?:(?!" + re.src_ZCc + "|" + text_separators + `|[()[\\]{}.,"'?!\\-;]).|\\[(?:(?!` + re.src_ZCc + "|\\]).)*\\]|\\((?:(?!" + re.src_ZCc + "|[)]).)*\\)|\\{(?:(?!" + re.src_ZCc + '|[}]).)*\\}|\\"(?:(?!' + re.src_ZCc + `|["]).)+\\"|\\'(?:(?!` + re.src_ZCc + "|[']).)+\\'|\\'(?=" + re.src_pseudo_letter + "|[-])|\\.{2,}[a-zA-Z0-9%/&]|\\.(?!" + re.src_ZCc + "|[.]|$)|" + (opts["---"] ? "\\-(?!--(?:[^-]|$))(?:-*)|" : "\\-+|") +
",(?!" + re.src_ZCc + "|$)|;(?!" + re.src_ZCc + "|$)|\\!+(?!" + re.src_ZCc + "|[!]|$)|\\?(?!" + re.src_ZCc + "|[?]|$))+|\\/)?";
    re.src_email_name = '[\\-;:&=\\+\\$,\\.a-zA-Z0-9_][\\-;:&=\\+\\$,\\"\\.a-zA-Z0-9_]*';
    re.src_xn = "xn--[a-z0-9\\-]{1,59}";
    re.src_domain_root =
"(?:" + re.src_xn + "|" + re.src_pseudo_letter + "{1,63})";
    re.src_domain = "(?:" + re.src_xn + "|(?:" + re.src_pseudo_letter + ")|(?:" + re.src_pseudo_letter + "(?:-|" + re.src_pseudo_letter + "){0,61}" + re.src_pseudo_letter + "))";
    re.src_host = "(?:(?:(?:(?:" + re.src_domain + ")\\.)*" + re.src_domain + "))";
    re.tpl_host_fuzzy = "(?:" + re.src_ip4 + "|(?:(?:(?:" + re.src_domain + ")\\.)+(?:%TLDS%)))";
    re.tpl_host_no_ip_fuzzy = "(?:(?:(?:" + re.src_domain + ")\\.)+(?:%TLDS%))";
    re.src_host_strict = re.src_host + re.src_host_terminator;
    re.tpl_host_fuzzy_strict = re.tpl_host_fuzzy + re.src_host_terminator;
    re.src_host_port_strict = re.src_host + re.src_port + re.src_host_terminator;
    re.tpl_host_port_fuzzy_strict = re.tpl_host_fuzzy + re.src_port + re.src_host_terminator;
    re.tpl_host_port_no_ip_fuzzy_strict = re.tpl_host_no_ip_fuzzy + re.src_port + re.src_host_terminator;
    re.tpl_host_fuzzy_test = "localhost|www\\.|\\.\\d{1,3}\\.|(?:\\.(?:%TLDS%)(?:" + re.src_ZPCc + "|>|$))";
    re.tpl_email_fuzzy = "(^|" + text_separators + '|"|\\(|' + re.src_ZCc + ")(" + re.src_email_name + "@" + re.tpl_host_fuzzy_strict + ")";
    re.tpl_link_fuzzy =

"(^|(?![.:/\\-_@])(?:[$+<=>^`|｜]|" + re.src_ZPCc + "))((?![$+<=>^`|｜])" + re.tpl_host_port_fuzzy_strict + re.src_path + ")";
    re.tpl_link_no_ip_fuzzy =

"(^|(?![.:/\\-_@])(?:[$+<=>^`|｜]|" + re.src_ZPCc + "))((?![$+<=>^`|｜])" + re.tpl_host_port_no_ip_fuzzy_strict + re.src_path + ")";
    return re;
  }
  function assign(obj) {
    const sources = Array.prototype.slice.call(arguments, 1);
    sources.forEach(function(source) {
      if (!source) {
        return;
      }
      Object.keys(source).forEach(function(key) {
        obj[key] = source[key];
      });
    });
    return obj;
  }
  function _class(obj) {
    return Object.prototype.toString.call(obj);
  }
  function isString(obj) {
    return _class(obj) === "[object String]";
  }
  function isObject(obj) {
    return _class(obj) === "[object Object]";
  }
  function isRegExp(obj) {
    return _class(obj) === "[object RegExp]";
  }
  function isFunction(obj) {
    return _class(obj) === "[object Function]";
  }
  function escapeRE(str) {
    return str.replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&");
  }
  const defaultOptions = {
    fuzzyLink: true,
    fuzzyEmail: true,
    fuzzyIP: false
  };
  function isOptionsObj(obj) {
    return Object.keys(obj || {}).reduce(function(acc, k) {
      return acc || defaultOptions.hasOwnProperty(k);
    }, false);
  }
  const defaultSchemas = {
    "http:": {
      validate: function(text2, pos, self) {
        const tail = text2.slice(pos);
        if (!self.re.http) {
          self.re.http = new RegExp(
            "^\\/\\/" + self.re.src_auth + self.re.src_host_port_strict + self.re.src_path,
            "i"
          );
        }
        if (self.re.http.test(tail)) {
          return tail.match(self.re.http)[0].length;
        }
        return 0;
      }
    },
    "https:": "http:",
    "ftp:": "http:",
    "//": {
      validate: function(text2, pos, self) {
        const tail = text2.slice(pos);
        if (!self.re.no_http) {
          self.re.no_http = new RegExp(
            "^" + self.re.src_auth +

"(?:localhost|(?:(?:" + self.re.src_domain + ")\\.)+" + self.re.src_domain_root + ")" + self.re.src_port + self.re.src_host_terminator + self.re.src_path,
            "i"
          );
        }
        if (self.re.no_http.test(tail)) {
          if (pos >= 3 && text2[pos - 3] === ":") {
            return 0;
          }
          if (pos >= 3 && text2[pos - 3] === "/") {
            return 0;
          }
          return tail.match(self.re.no_http)[0].length;
        }
        return 0;
      }
    },
    "mailto:": {
      validate: function(text2, pos, self) {
        const tail = text2.slice(pos);
        if (!self.re.mailto) {
          self.re.mailto = new RegExp(
            "^" + self.re.src_email_name + "@" + self.re.src_host_strict,
            "i"
          );
        }
        if (self.re.mailto.test(tail)) {
          return tail.match(self.re.mailto)[0].length;
        }
        return 0;
      }
    }
  };
  const tlds_2ch_src_re = "a[cdefgilmnoqrstuwxz]|b[abdefghijmnorstvwyz]|c[acdfghiklmnoruvwxyz]|d[ejkmoz]|e[cegrstu]|f[ijkmor]|g[abdefghilmnpqrstuwy]|h[kmnrtu]|i[delmnoqrst]|j[emop]|k[eghimnprwyz]|l[abcikrstuvy]|m[acdeghklmnopqrstuvwxyz]|n[acefgilopruz]|om|p[aefghklmnrstwy]|qa|r[eosuw]|s[abcdeghijklmnortuvxyz]|t[cdfghjklmnortvwz]|u[agksyz]|v[aceginu]|w[fs]|y[et]|z[amw]";
  const tlds_default = "biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф".split("|");
  function resetScanCache(self) {
    self.__index__ = -1;
    self.__text_cache__ = "";
  }
  function createValidator(re) {
    return function(text2, pos) {
      const tail = text2.slice(pos);
      if (re.test(tail)) {
        return tail.match(re)[0].length;
      }
      return 0;
    };
  }
  function createNormalizer() {
    return function(match2, self) {
      self.normalize(match2);
    };
  }
  function compile(self) {
    const re = self.re = reFactory(self.__opts__);
    const tlds2 = self.__tlds__.slice();
    self.onCompile();
    if (!self.__tlds_replaced__) {
      tlds2.push(tlds_2ch_src_re);
    }
    tlds2.push(re.src_xn);
    re.src_tlds = tlds2.join("|");
    function untpl(tpl) {
      return tpl.replace("%TLDS%", re.src_tlds);
    }
    re.email_fuzzy = RegExp(untpl(re.tpl_email_fuzzy), "i");
    re.link_fuzzy = RegExp(untpl(re.tpl_link_fuzzy), "i");
    re.link_no_ip_fuzzy = RegExp(untpl(re.tpl_link_no_ip_fuzzy), "i");
    re.host_fuzzy_test = RegExp(untpl(re.tpl_host_fuzzy_test), "i");
    const aliases = [];
    self.__compiled__ = {};
    function schemaError(name, val) {
      throw new Error('(LinkifyIt) Invalid schema "' + name + '": ' + val);
    }
    Object.keys(self.__schemas__).forEach(function(name) {
      const val = self.__schemas__[name];
      if (val === null) {
        return;
      }
      const compiled = { validate: null, link: null };
      self.__compiled__[name] = compiled;
      if (isObject(val)) {
        if (isRegExp(val.validate)) {
          compiled.validate = createValidator(val.validate);
        } else if (isFunction(val.validate)) {
          compiled.validate = val.validate;
        } else {
          schemaError(name, val);
        }
        if (isFunction(val.normalize)) {
          compiled.normalize = val.normalize;
        } else if (!val.normalize) {
          compiled.normalize = createNormalizer();
        } else {
          schemaError(name, val);
        }
        return;
      }
      if (isString(val)) {
        aliases.push(name);
        return;
      }
      schemaError(name, val);
    });
    aliases.forEach(function(alias) {
      if (!self.__compiled__[self.__schemas__[alias]]) {
        return;
      }
      self.__compiled__[alias].validate = self.__compiled__[self.__schemas__[alias]].validate;
      self.__compiled__[alias].normalize = self.__compiled__[self.__schemas__[alias]].normalize;
    });
    self.__compiled__[""] = { validate: null, normalize: createNormalizer() };
    const slist = Object.keys(self.__compiled__).filter(function(name) {
      return name.length > 0 && self.__compiled__[name];
    }).map(escapeRE).join("|");
    self.re.schema_test = RegExp("(^|(?!_)(?:[><｜]|" + re.src_ZPCc + "))(" + slist + ")", "i");
    self.re.schema_search = RegExp("(^|(?!_)(?:[><｜]|" + re.src_ZPCc + "))(" + slist + ")", "ig");
    self.re.schema_at_start = RegExp("^" + self.re.schema_search.source, "i");
    self.re.pretest = RegExp(
      "(" + self.re.schema_test.source + ")|(" + self.re.host_fuzzy_test.source + ")|@",
      "i"
    );
    resetScanCache(self);
  }
  function Match(self, shift) {
    const start = self.__index__;
    const end = self.__last_index__;
    const text2 = self.__text_cache__.slice(start, end);
    this.schema = self.__schema__.toLowerCase();
    this.index = start + shift;
    this.lastIndex = end + shift;
    this.raw = text2;
    this.text = text2;
    this.url = text2;
  }
  function createMatch(self, shift) {
    const match2 = new Match(self, shift);
    self.__compiled__[match2.schema].normalize(match2, self);
    return match2;
  }
  function LinkifyIt(schemas, options) {
    if (!(this instanceof LinkifyIt)) {
      return new LinkifyIt(schemas, options);
    }
    if (!options) {
      if (isOptionsObj(schemas)) {
        options = schemas;
        schemas = {};
      }
    }
    this.__opts__ = assign({}, defaultOptions, options);
    this.__index__ = -1;
    this.__last_index__ = -1;
    this.__schema__ = "";
    this.__text_cache__ = "";
    this.__schemas__ = assign({}, defaultSchemas, schemas);
    this.__compiled__ = {};
    this.__tlds__ = tlds_default;
    this.__tlds_replaced__ = false;
    this.re = {};
    compile(this);
  }
  LinkifyIt.prototype.add = function add(schema, definition) {
    this.__schemas__[schema] = definition;
    compile(this);
    return this;
  };
  LinkifyIt.prototype.set = function set(options) {
    this.__opts__ = assign(this.__opts__, options);
    return this;
  };
  LinkifyIt.prototype.test = function test(text2) {
    this.__text_cache__ = text2;
    this.__index__ = -1;
    if (!text2.length) {
      return false;
    }
    let m, ml, me, len, shift, next, re, tld_pos, at_pos;
    if (this.re.schema_test.test(text2)) {
      re = this.re.schema_search;
      re.lastIndex = 0;
      while ((m = re.exec(text2)) !== null) {
        len = this.testSchemaAt(text2, m[2], re.lastIndex);
        if (len) {
          this.__schema__ = m[2];
          this.__index__ = m.index + m[1].length;
          this.__last_index__ = m.index + m[0].length + len;
          break;
        }
      }
    }
    if (this.__opts__.fuzzyLink && this.__compiled__["http:"]) {
      tld_pos = text2.search(this.re.host_fuzzy_test);
      if (tld_pos >= 0) {
        if (this.__index__ < 0 || tld_pos < this.__index__) {
          if ((ml = text2.match(this.__opts__.fuzzyIP ? this.re.link_fuzzy : this.re.link_no_ip_fuzzy)) !== null) {
            shift = ml.index + ml[1].length;
            if (this.__index__ < 0 || shift < this.__index__) {
              this.__schema__ = "";
              this.__index__ = shift;
              this.__last_index__ = ml.index + ml[0].length;
            }
          }
        }
      }
    }
    if (this.__opts__.fuzzyEmail && this.__compiled__["mailto:"]) {
      at_pos = text2.indexOf("@");
      if (at_pos >= 0) {
        if ((me = text2.match(this.re.email_fuzzy)) !== null) {
          shift = me.index + me[1].length;
          next = me.index + me[0].length;
          if (this.__index__ < 0 || shift < this.__index__ || shift === this.__index__ && next > this.__last_index__) {
            this.__schema__ = "mailto:";
            this.__index__ = shift;
            this.__last_index__ = next;
          }
        }
      }
    }
    return this.__index__ >= 0;
  };
  LinkifyIt.prototype.pretest = function pretest(text2) {
    return this.re.pretest.test(text2);
  };
  LinkifyIt.prototype.testSchemaAt = function testSchemaAt(text2, schema, pos) {
    if (!this.__compiled__[schema.toLowerCase()]) {
      return 0;
    }
    return this.__compiled__[schema.toLowerCase()].validate(text2, pos, this);
  };
  LinkifyIt.prototype.match = function match(text2) {
    const result = [];
    let shift = 0;
    if (this.__index__ >= 0 && this.__text_cache__ === text2) {
      result.push(createMatch(this, shift));
      shift = this.__last_index__;
    }
    let tail = shift ? text2.slice(shift) : text2;
    while (this.test(tail)) {
      result.push(createMatch(this, shift));
      tail = tail.slice(this.__last_index__);
      shift += this.__last_index__;
    }
    if (result.length) {
      return result;
    }
    return null;
  };
  LinkifyIt.prototype.matchAtStart = function matchAtStart(text2) {
    this.__text_cache__ = text2;
    this.__index__ = -1;
    if (!text2.length) return null;
    const m = this.re.schema_at_start.exec(text2);
    if (!m) return null;
    const len = this.testSchemaAt(text2, m[2], m[0].length);
    if (!len) return null;
    this.__schema__ = m[2];
    this.__index__ = m.index + m[1].length;
    this.__last_index__ = m.index + m[0].length + len;
    return createMatch(this, 0);
  };
  LinkifyIt.prototype.tlds = function tlds(list2, keepOld) {
    list2 = Array.isArray(list2) ? list2 : [list2];
    if (!keepOld) {
      this.__tlds__ = list2.slice();
      this.__tlds_replaced__ = true;
      compile(this);
      return this;
    }
    this.__tlds__ = this.__tlds__.concat(list2).sort().filter(function(el, idx, arr) {
      return el !== arr[idx - 1];
    }).reverse();
    compile(this);
    return this;
  };
  LinkifyIt.prototype.normalize = function normalize2(match2) {
    if (!match2.schema) {
      match2.url = "http://" + match2.url;
    }
    if (match2.schema === "mailto:" && !/^mailto:/i.test(match2.url)) {
      match2.url = "mailto:" + match2.url;
    }
  };
  LinkifyIt.prototype.onCompile = function onCompile() {
  };
  const maxInt = 2147483647;
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const skew = 38;
  const damp = 700;
  const initialBias = 72;
  const initialN = 128;
  const delimiter = "-";
  const regexPunycode = /^xn--/;
  const regexNonASCII = /[^\0-\x7F]/;
  const regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g;
  const errors = {
    "overflow": "Overflow: input needs wider integers to process",
    "not-basic": "Illegal input >= 0x80 (not a basic code point)",
    "invalid-input": "Invalid input"
  };
  const baseMinusTMin = base - tMin;
  const floor = Math.floor;
  const stringFromCharCode = String.fromCharCode;
  function error(type) {
    throw new RangeError(errors[type]);
  }
  function map(array, callback) {
    const result = [];
    let length = array.length;
    while (length--) {
      result[length] = callback(array[length]);
    }
    return result;
  }
  function mapDomain(domain, callback) {
    const parts = domain.split("@");
    let result = "";
    if (parts.length > 1) {
      result = parts[0] + "@";
      domain = parts[1];
    }
    domain = domain.replace(regexSeparators, ".");
    const labels = domain.split(".");
    const encoded = map(labels, callback).join(".");
    return result + encoded;
  }
  function ucs2decode(string) {
    const output = [];
    let counter = 0;
    const length = string.length;
    while (counter < length) {
      const value = string.charCodeAt(counter++);
      if (value >= 55296 && value <= 56319 && counter < length) {
        const extra = string.charCodeAt(counter++);
        if ((extra & 64512) == 56320) {
          output.push(((value & 1023) << 10) + (extra & 1023) + 65536);
        } else {
          output.push(value);
          counter--;
        }
      } else {
        output.push(value);
      }
    }
    return output;
  }
  const ucs2encode = (codePoints) => String.fromCodePoint(...codePoints);
  const basicToDigit = function(codePoint) {
    if (codePoint >= 48 && codePoint < 58) {
      return 26 + (codePoint - 48);
    }
    if (codePoint >= 65 && codePoint < 91) {
      return codePoint - 65;
    }
    if (codePoint >= 97 && codePoint < 123) {
      return codePoint - 97;
    }
    return base;
  };
  const digitToBasic = function(digit, flag) {
    return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
  };
  const adapt = function(delta, numPoints, firstTime) {
    let k = 0;
    delta = firstTime ? floor(delta / damp) : delta >> 1;
    delta += floor(delta / numPoints);
    for (; delta > baseMinusTMin * tMax >> 1; k += base) {
      delta = floor(delta / baseMinusTMin);
    }
    return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
  };
  const decode = function(input) {
    const output = [];
    const inputLength = input.length;
    let i = 0;
    let n = initialN;
    let bias = initialBias;
    let basic = input.lastIndexOf(delimiter);
    if (basic < 0) {
      basic = 0;
    }
    for (let j = 0; j < basic; ++j) {
      if (input.charCodeAt(j) >= 128) {
        error("not-basic");
      }
      output.push(input.charCodeAt(j));
    }
    for (let index = basic > 0 ? basic + 1 : 0; index < inputLength; ) {
      const oldi = i;
      for (let w = 1, k = base; ; k += base) {
        if (index >= inputLength) {
          error("invalid-input");
        }
        const digit = basicToDigit(input.charCodeAt(index++));
        if (digit >= base) {
          error("invalid-input");
        }
        if (digit > floor((maxInt - i) / w)) {
          error("overflow");
        }
        i += digit * w;
        const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
        if (digit < t) {
          break;
        }
        const baseMinusT = base - t;
        if (w > floor(maxInt / baseMinusT)) {
          error("overflow");
        }
        w *= baseMinusT;
      }
      const out = output.length + 1;
      bias = adapt(i - oldi, out, oldi == 0);
      if (floor(i / out) > maxInt - n) {
        error("overflow");
      }
      n += floor(i / out);
      i %= out;
      output.splice(i++, 0, n);
    }
    return String.fromCodePoint(...output);
  };
  const encode = function(input) {
    const output = [];
    input = ucs2decode(input);
    const inputLength = input.length;
    let n = initialN;
    let delta = 0;
    let bias = initialBias;
    for (const currentValue of input) {
      if (currentValue < 128) {
        output.push(stringFromCharCode(currentValue));
      }
    }
    const basicLength = output.length;
    let handledCPCount = basicLength;
    if (basicLength) {
      output.push(delimiter);
    }
    while (handledCPCount < inputLength) {
      let m = maxInt;
      for (const currentValue of input) {
        if (currentValue >= n && currentValue < m) {
          m = currentValue;
        }
      }
      const handledCPCountPlusOne = handledCPCount + 1;
      if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
        error("overflow");
      }
      delta += (m - n) * handledCPCountPlusOne;
      n = m;
      for (const currentValue of input) {
        if (currentValue < n && ++delta > maxInt) {
          error("overflow");
        }
        if (currentValue === n) {
          let q = delta;
          for (let k = base; ; k += base) {
            const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
            if (q < t) {
              break;
            }
            const qMinusT = q - t;
            const baseMinusT = base - t;
            output.push(
              stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
            );
            q = floor(qMinusT / baseMinusT);
          }
          output.push(stringFromCharCode(digitToBasic(q, 0)));
          bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
          delta = 0;
          ++handledCPCount;
        }
      }
      ++delta;
      ++n;
    }
    return output.join("");
  };
  const toUnicode = function(input) {
    return mapDomain(input, function(string) {
      return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string;
    });
  };
  const toASCII = function(input) {
    return mapDomain(input, function(string) {
      return regexNonASCII.test(string) ? "xn--" + encode(string) : string;
    });
  };
  const punycode = {
"version": "2.3.1",
"ucs2": {
      "decode": ucs2decode,
      "encode": ucs2encode
    },
    "decode": decode,
    "encode": encode,
    "toASCII": toASCII,
    "toUnicode": toUnicode
  };
  const cfg_default = {
    options: {
html: false,
xhtmlOut: false,
breaks: false,
langPrefix: "language-",
linkify: false,
typographer: false,




quotes: "“”‘’",






highlight: null,
maxNesting: 100
    },
    components: {
      core: {},
      block: {},
      inline: {}
    }
  };
  const cfg_zero = {
    options: {
html: false,
xhtmlOut: false,
breaks: false,
langPrefix: "language-",
linkify: false,
typographer: false,




quotes: "“”‘’",






highlight: null,
maxNesting: 20
    },
    components: {
      core: {
        rules: [
          "normalize",
          "block",
          "inline",
          "text_join"
        ]
      },
      block: {
        rules: [
          "paragraph"
        ]
      },
      inline: {
        rules: [
          "text"
        ],
        rules2: [
          "balance_pairs",
          "fragments_join"
        ]
      }
    }
  };
  const cfg_commonmark = {
    options: {
html: true,
xhtmlOut: true,
breaks: false,
langPrefix: "language-",
linkify: false,
typographer: false,




quotes: "“”‘’",






highlight: null,
maxNesting: 20
    },
    components: {
      core: {
        rules: [
          "normalize",
          "block",
          "inline",
          "text_join"
        ]
      },
      block: {
        rules: [
          "blockquote",
          "code",
          "fence",
          "heading",
          "hr",
          "html_block",
          "lheading",
          "list",
          "reference",
          "paragraph"
        ]
      },
      inline: {
        rules: [
          "autolink",
          "backticks",
          "emphasis",
          "entity",
          "escape",
          "html_inline",
          "image",
          "link",
          "newline",
          "text"
        ],
        rules2: [
          "balance_pairs",
          "emphasis",
          "fragments_join"
        ]
      }
    }
  };
  const config = {
    default: cfg_default,
    zero: cfg_zero,
    commonmark: cfg_commonmark
  };
  const BAD_PROTO_RE = /^(vbscript|javascript|file|data):/;
  const GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/;
  function validateLink(url) {
    const str = url.trim().toLowerCase();
    return BAD_PROTO_RE.test(str) ? GOOD_DATA_RE.test(str) : true;
  }
  const RECODE_HOSTNAME_FOR = ["http:", "https:", "mailto:"];
  function normalizeLink(url) {
    const parsed = urlParse(url, true);
    if (parsed.hostname) {
      if (!parsed.protocol || RECODE_HOSTNAME_FOR.indexOf(parsed.protocol) >= 0) {
        try {
          parsed.hostname = punycode.toASCII(parsed.hostname);
        } catch (er) {
        }
      }
    }
    return encode$1(format(parsed));
  }
  function normalizeLinkText(url) {
    const parsed = urlParse(url, true);
    if (parsed.hostname) {
      if (!parsed.protocol || RECODE_HOSTNAME_FOR.indexOf(parsed.protocol) >= 0) {
        try {
          parsed.hostname = punycode.toUnicode(parsed.hostname);
        } catch (er) {
        }
      }
    }
    return decode$1(format(parsed), decode$1.defaultChars + "%");
  }
  function MarkdownIt(presetName, options) {
    if (!(this instanceof MarkdownIt)) {
      return new MarkdownIt(presetName, options);
    }
    if (!options) {
      if (!isString$1(presetName)) {
        options = presetName || {};
        presetName = "default";
      }
    }
    this.inline = new ParserInline();
    this.block = new ParserBlock();
    this.core = new Core();
    this.renderer = new Renderer();
    this.linkify = new LinkifyIt();
    this.validateLink = validateLink;
    this.normalizeLink = normalizeLink;
    this.normalizeLinkText = normalizeLinkText;
    this.utils = utils;
    this.helpers = assign$1({}, helpers);
    this.options = {};
    this.configure(presetName);
    if (options) {
      this.set(options);
    }
  }
  MarkdownIt.prototype.set = function(options) {
    assign$1(this.options, options);
    return this;
  };
  MarkdownIt.prototype.configure = function(presets) {
    const self = this;
    if (isString$1(presets)) {
      const presetName = presets;
      presets = config[presetName];
      if (!presets) {
        throw new Error('Wrong `markdown-it` preset "' + presetName + '", check name');
      }
    }
    if (!presets) {
      throw new Error("Wrong `markdown-it` preset, can't be empty");
    }
    if (presets.options) {
      self.set(presets.options);
    }
    if (presets.components) {
      Object.keys(presets.components).forEach(function(name) {
        if (presets.components[name].rules) {
          self[name].ruler.enableOnly(presets.components[name].rules);
        }
        if (presets.components[name].rules2) {
          self[name].ruler2.enableOnly(presets.components[name].rules2);
        }
      });
    }
    return this;
  };
  MarkdownIt.prototype.enable = function(list2, ignoreInvalid) {
    let result = [];
    if (!Array.isArray(list2)) {
      list2 = [list2];
    }
    ["core", "block", "inline"].forEach(function(chain) {
      result = result.concat(this[chain].ruler.enable(list2, true));
    }, this);
    result = result.concat(this.inline.ruler2.enable(list2, true));
    const missed = list2.filter(function(name) {
      return result.indexOf(name) < 0;
    });
    if (missed.length && !ignoreInvalid) {
      throw new Error("MarkdownIt. Failed to enable unknown rule(s): " + missed);
    }
    return this;
  };
  MarkdownIt.prototype.disable = function(list2, ignoreInvalid) {
    let result = [];
    if (!Array.isArray(list2)) {
      list2 = [list2];
    }
    ["core", "block", "inline"].forEach(function(chain) {
      result = result.concat(this[chain].ruler.disable(list2, true));
    }, this);
    result = result.concat(this.inline.ruler2.disable(list2, true));
    const missed = list2.filter(function(name) {
      return result.indexOf(name) < 0;
    });
    if (missed.length && !ignoreInvalid) {
      throw new Error("MarkdownIt. Failed to disable unknown rule(s): " + missed);
    }
    return this;
  };
  MarkdownIt.prototype.use = function(plugin) {
    const args = [this].concat(Array.prototype.slice.call(arguments, 1));
    plugin.apply(plugin, args);
    return this;
  };
  MarkdownIt.prototype.parse = function(src, env) {
    if (typeof src !== "string") {
      throw new Error("Input data should be a String");
    }
    const state2 = new this.core.State(src, this, env);
    this.core.process(state2);
    return state2.tokens;
  };
  MarkdownIt.prototype.render = function(src, env) {
    env = env || {};
    return this.renderer.render(this.parse(src, env), this.options, env);
  };
  MarkdownIt.prototype.parseInline = function(src, env) {
    const state2 = new this.core.State(src, this, env);
    state2.inlineMode = true;
    this.core.process(state2);
    return state2.tokens;
  };
  MarkdownIt.prototype.renderInline = function(src, env) {
    env = env || {};
    return this.renderer.render(this.parseInline(src, env), this.options, env);
  };
  const AI_RESULT_VISIBLE_CLASS = "is-visible";
  const AI_STATUS_ERROR_CLASS = "is-error";
  const AI_BUTTON_LOADING_CLASS = "is-loading";
  const AI_BUTTON_CLOSE_CLASS = "is-close";
  const AI_BUTTON_CLOSE_MODE = "close";
  const AI_RESULT_AUTO_FOLLOW_THRESHOLD_PX = 40;
  const markdownRenderer = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true
  });
  let latestAiRequestToken = 0;
  let dragTransformRafId = 0;
  let activeAiTaskAbortController = null;
  function getAiTaskButtonLabel(taskType) {
    return taskType === "explain" ? "解释" : "翻译";
  }
  function getButtonTaskType(button) {
    return button.dataset.aiTask === "translate" ? "translate" : "explain";
  }
  function setAiTaskButtonCloseMode(button, enabled) {
    if (enabled) {
      button.dataset.mode = AI_BUTTON_CLOSE_MODE;
      button.classList.add(AI_BUTTON_CLOSE_CLASS);
      button.textContent = "关闭";
      button.title = "关闭结果面板";
      button.setAttribute("aria-label", "关闭结果面板");
      return;
    }
    const taskType = getButtonTaskType(button);
    const label = getAiTaskButtonLabel(taskType);
    delete button.dataset.mode;
    button.classList.remove(AI_BUTTON_CLOSE_CLASS);
    button.textContent = label;
    button.title = `执行${label}`;
    button.setAttribute("aria-label", label);
  }
  function resetAiTaskButtonModes(elements) {
    setAiTaskButtonCloseMode(elements.explainButton, false);
    setAiTaskButtonCloseMode(elements.translateButton, false);
  }
  function markAiTaskButtonAsClose(elements, taskType) {
    const targetButton = taskType === "explain" ? elements.explainButton : elements.translateButton;
    const otherButton = taskType === "explain" ? elements.translateButton : elements.explainButton;
    setAiTaskButtonCloseMode(targetButton, true);
    setAiTaskButtonCloseMode(otherButton, false);
  }
  function parseAiTaskType(rawValue) {
    if (rawValue === "explain" || rawValue === "translate") {
      return rawValue;
    }
    return null;
  }
  function getAiTaskLoadingMessage(taskType) {
    return taskType === "explain" ? "正在解释图片…" : "正在识别并翻译图片文字…";
  }
  function getAiTaskSuccessMessage(taskType) {
    return taskType === "explain" ? "图片解释完成。" : "图片翻译完成。";
  }
  async function fetchInlineImagePayload(imageUrl) {
    return fetchInlineImagePayloadViaUserscript(imageUrl, activeAiTaskAbortController?.signal);
  }
  function getOverlayAiElements(overlay) {
    const explainButton = overlay.querySelector('[data-ai-task="explain"]');
    const translateButton = overlay.querySelector('[data-ai-task="translate"]');
    const status = overlay.querySelector('[data-role="ai-status"]');
    const result = overlay.querySelector('[data-role="ai-result"]');
    if (!explainButton || !translateButton || !status || !result) {
      return null;
    }
    return {
      explainButton,
      translateButton,
      status,
      result
    };
  }
  function setAiLoadingState(elements, loading, taskType) {
    const isExplainLoading = loading && taskType === "explain";
    const isTranslateLoading = loading && taskType === "translate";
    elements.explainButton.disabled = loading;
    elements.translateButton.disabled = loading;
    elements.explainButton.classList.toggle(AI_BUTTON_LOADING_CLASS, isExplainLoading);
    elements.translateButton.classList.toggle(AI_BUTTON_LOADING_CLASS, isTranslateLoading);
  }
  function setAiStatus(elements, message, isError = false) {
    elements.status.textContent = message;
    elements.status.classList.toggle(AI_STATUS_ERROR_CLASS, isError);
  }
  function normalizeMarkdownHeadings(message) {
    const lines = message.split(/\r?\n/);
    const normalizedLines = [];
    let insideFenceBlock = false;
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) {
        insideFenceBlock = !insideFenceBlock;
        normalizedLines.push(line);
        continue;
      }
      if (insideFenceBlock) {
        normalizedLines.push(line);
        continue;
      }
      const normalizedAsciiHeading = line.replace(/^(\s{0,3})(#{1,6})([^\s#])/, "$1$2 $3");
      const normalizedHeading = normalizedAsciiHeading.replace(
        /^(\s{0,3})(＃{1,6})([^\s＃])/,
        (_match, indent, fullWidthHashes, headingContentStart) => `${indent}${"#".repeat(fullWidthHashes.length)} ${headingContentStart}`
      );
      normalizedLines.push(normalizedHeading);
    }
    return normalizedLines.join("\n");
  }
  function scrollAiResultToBottom(resultElement) {
    resultElement.scrollTop = resultElement.scrollHeight;
  }
  function isAiResultNearBottom(resultElement) {
    const distanceToBottom = resultElement.scrollHeight - (resultElement.scrollTop + resultElement.clientHeight);
    return distanceToBottom <= AI_RESULT_AUTO_FOLLOW_THRESHOLD_PX;
  }
  function setAiResult(elements, message) {
    const safeMessage = message.trim();
    if (!safeMessage) {
      elements.result.innerHTML = "";
      elements.result.classList.remove(AI_RESULT_VISIBLE_CLASS);
      elements.result.scrollTop = 0;
      return;
    }
    const normalizedMessage = normalizeMarkdownHeadings(safeMessage);
    const shouldAutoFollow = isAiResultNearBottom(elements.result);
    try {
      elements.result.innerHTML = markdownRenderer.render(normalizedMessage);
    } catch (error2) {
      elements.result.textContent = normalizedMessage;
    }
    elements.result.classList.add(AI_RESULT_VISIBLE_CLASS);
    if (shouldAutoFollow) {
      scrollAiResultToBottom(elements.result);
    }
  }
  function cancelScheduledDragTransform() {
    if (!dragTransformRafId) return;
    window.cancelAnimationFrame(dragTransformRafId);
    dragTransformRafId = 0;
  }
  function scheduleDragTransformApply() {
    if (dragTransformRafId) return;
    dragTransformRafId = window.requestAnimationFrame(() => {
      dragTransformRafId = 0;
      applyTransform();
    });
  }
  function cancelActiveAiTask() {
    if (!activeAiTaskAbortController) return;
    activeAiTaskAbortController.abort();
    activeAiTaskAbortController = null;
  }
  function resetAiUi(overlay) {
    const elements = getOverlayAiElements(overlay);
    if (!elements) return;
    setAiLoadingState(elements, false);
    resetAiTaskButtonModes(elements);
    setAiStatus(elements, "");
    setAiResult(elements, "");
  }
  function closeAiTaskPanel(overlay, taskType) {
    cancelActiveAiTask();
    latestAiRequestToken += 1;
    const elements = getOverlayAiElements(overlay);
    if (!elements) return;
    setAiLoadingState(elements, false);
    setAiStatus(elements, "");
    setAiResult(elements, "");
    const targetButton = taskType === "explain" ? elements.explainButton : elements.translateButton;
    setAiTaskButtonCloseMode(targetButton, false);
  }
  async function runImageAiTask(taskType, overlay) {
    if (!state.isOpen || !state.activeImageUrl) {
      return;
    }
    const elements = getOverlayAiElements(overlay);
    if (!elements) return;
    cancelActiveAiTask();
    const abortController = new AbortController();
    activeAiTaskAbortController = abortController;
    const currentImageUrl = state.activeImageUrl;
    const requestToken = ++latestAiRequestToken;
    setAiLoadingState(elements, true, taskType);
    resetAiTaskButtonModes(elements);
    setAiStatus(elements, getAiTaskLoadingMessage(taskType));
    setAiResult(elements, "");
    try {
      const imagePayload = await fetchInlineImagePayload(currentImageUrl);
      if (requestToken !== latestAiRequestToken) return;
      const aiResult = await generateImageTaskStreamWithConfiguredAi({
        image: imagePayload,
        taskType,
        abortSignal: abortController.signal,
        onChunk: (aggregatedText) => {
          if (requestToken !== latestAiRequestToken) return;
          setAiResult(elements, aggregatedText);
        }
      });
      if (requestToken !== latestAiRequestToken) return;
      setAiResult(elements, aiResult || "模型未返回文本结果。");
      setAiStatus(elements, getAiTaskSuccessMessage(taskType));
      markAiTaskButtonAsClose(elements, taskType);
    } catch (error2) {
      if (requestToken !== latestAiRequestToken) return;
      if (error2 instanceof DOMException && error2.name === "AbortError") {
        return;
      }
      const errorMessage = error2 instanceof Error && error2.message.trim() ? error2.message.trim() : "AI 请求失败，请稍后重试。";
      setAiStatus(elements, errorMessage, true);
    } finally {
      if (activeAiTaskAbortController === abortController) {
        activeAiTaskAbortController = null;
      }
      if (requestToken === latestAiRequestToken) {
        setAiLoadingState(elements, false);
      }
    }
  }
  function ensureStyle() {
    if (document.getElementById(CONFIG.styleId)) return;
    const style = document.createElement("style");
    style.id = CONFIG.styleId;
    style.textContent = `
#${CONFIG.overlayId} {
  position: fixed;
  inset: 0;
  z-index: ${CONFIG.overlayZIndex};
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.78);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity ${CONFIG.animationDurationMs}ms ease, visibility ${CONFIG.animationDurationMs}ms ease;
}

#${CONFIG.overlayId}.is-open {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

#${CONFIG.overlayId} .hl-tm-image-stage {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 90vw;
  max-height: 90vh;
}

#${CONFIG.overlayId} .hl-tm-preview-image {
  max-width: 90vw;
  max-height: 90vh;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 10px;
  box-shadow: 0 14px 44px rgba(0, 0, 0, 0.45);
  transform: translate3d(0, 0, 0) scale(1);
  transform-origin: center center;
  transition: transform 60ms linear;
  cursor: grab;
  user-select: none;
  -webkit-user-drag: none;
  touch-action: none;
}

#${CONFIG.overlayId}.is-dragging .hl-tm-preview-image {
  cursor: grabbing;
  transition: none !important;
  will-change: transform;
  box-shadow: none;
}

#${CONFIG.overlayId}.is-dragging .hl-tm-ai-pill {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

#${CONFIG.overlayId} .hl-tm-ai-tools {
  position: fixed;
  top: calc(env(safe-area-inset-top) + 10px);
  left: 50%;
  transform: translate3d(-50%, 0, 0);
  width: min(700px, calc(100vw - 20px));
  display: grid;
  gap: 8px;
  justify-items: center;
  pointer-events: auto;
}

#${CONFIG.overlayId} .hl-tm-ai-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  padding: 6px;
  border-radius: 999px;
  border: 1px solid rgba(169, 196, 242, 0.34);
  background: rgba(10, 17, 29, 0.76);
  box-shadow: 0 10px 24px rgba(5, 9, 15, 0.34);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

#${CONFIG.overlayId} .hl-tm-ai-actions {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
}

#${CONFIG.overlayId} .hl-tm-ai-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  padding: 6px 12px;
  border: 1px solid rgba(174, 201, 244, 0.36);
  border-radius: 999px;
  background: rgba(26, 39, 61, 0.84);
  color: rgba(233, 240, 255, 0.96);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 100ms ease;
}

#${CONFIG.overlayId} .hl-tm-ai-action:hover {
  background: rgba(31, 47, 73, 0.84);
  border-color: rgba(165, 198, 255, 0.58);
}

#${CONFIG.overlayId} .hl-tm-ai-action:active {
  transform: translateY(1px);
}

#${CONFIG.overlayId} .hl-tm-ai-action:focus-visible {
  outline: none;
  border-color: rgba(129, 178, 255, 0.96);
  box-shadow: 0 0 0 3px rgba(94, 148, 255, 0.28);
}

#${CONFIG.overlayId} .hl-tm-ai-action:disabled {
  opacity: 0.7;
  cursor: wait;
}

#${CONFIG.overlayId} .hl-tm-ai-action.${AI_BUTTON_CLOSE_CLASS} {
  background: rgba(126, 44, 54, 0.9);
  border-color: rgba(255, 161, 171, 0.62);
  color: rgba(255, 234, 238, 0.98);
}

#${CONFIG.overlayId} .hl-tm-ai-action.${AI_BUTTON_CLOSE_CLASS}:hover {
  background: rgba(153, 55, 67, 0.94);
  border-color: rgba(255, 183, 191, 0.76);
}

#${CONFIG.overlayId} .hl-tm-ai-action.is-loading::after {
  content: "";
  width: 12px;
  height: 12px;
  margin-left: 6px;
  border-radius: 999px;
  border: 2px solid rgba(195, 216, 255, 0.36);
  border-top-color: rgba(240, 247, 255, 0.96);
  animation: hl-tm-ai-spin 720ms linear infinite;
}

#${CONFIG.overlayId} .hl-tm-ai-status {
  display: none;
}

#${CONFIG.overlayId} .hl-tm-ai-status.is-error {
  color: rgba(255, 175, 175, 0.98);
}

#${CONFIG.overlayId} .hl-tm-ai-result {
  display: none;
  width: 100%;
  min-height: 120px;
  max-height: min(46vh, calc(100% - 70px));
  overflow: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(171, 194, 236, 0.3);
  background: rgba(8, 13, 23, 0.82);
  color: rgba(236, 243, 255, 0.96);
  font-size: 13px;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: left;
}

#${CONFIG.overlayId} .hl-tm-ai-result > :first-child {
  margin-top: 0;
}

#${CONFIG.overlayId} .hl-tm-ai-result > :last-child {
  margin-bottom: 0;
}

#${CONFIG.overlayId} .hl-tm-ai-result p,
#${CONFIG.overlayId} .hl-tm-ai-result ul,
#${CONFIG.overlayId} .hl-tm-ai-result ol,
#${CONFIG.overlayId} .hl-tm-ai-result pre,
#${CONFIG.overlayId} .hl-tm-ai-result blockquote,
#${CONFIG.overlayId} .hl-tm-ai-result hr {
  margin: 0.5em 0;
}

#${CONFIG.overlayId} .hl-tm-ai-result h1,
#${CONFIG.overlayId} .hl-tm-ai-result h2,
#${CONFIG.overlayId} .hl-tm-ai-result h3,
#${CONFIG.overlayId} .hl-tm-ai-result h4,
#${CONFIG.overlayId} .hl-tm-ai-result h5,
#${CONFIG.overlayId} .hl-tm-ai-result h6 {
  margin: 0.7em 0 0.45em;
  line-height: 1.35;
  font-weight: 700;
}

#${CONFIG.overlayId} .hl-tm-ai-result h1 {
  font-size: 1.45em;
}

#${CONFIG.overlayId} .hl-tm-ai-result h2 {
  font-size: 1.32em;
}

#${CONFIG.overlayId} .hl-tm-ai-result h3 {
  font-size: 1.22em;
}

#${CONFIG.overlayId} .hl-tm-ai-result h4 {
  font-size: 1.13em;
}

#${CONFIG.overlayId} .hl-tm-ai-result h5 {
  font-size: 1.05em;
}

#${CONFIG.overlayId} .hl-tm-ai-result h6 {
  font-size: 1em;
}

#${CONFIG.overlayId} .hl-tm-ai-result ul,
#${CONFIG.overlayId} .hl-tm-ai-result ol {
  padding-left: 1.3em;
}

#${CONFIG.overlayId} .hl-tm-ai-result code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.92em;
  padding: 0.1em 0.35em;
  border-radius: 6px;
  background: rgba(25, 37, 56, 0.78);
}

#${CONFIG.overlayId} .hl-tm-ai-result pre {
  padding: 0.65em 0.75em;
  border-radius: 8px;
  background: rgba(20, 31, 48, 0.9);
  overflow: auto;
}

#${CONFIG.overlayId} .hl-tm-ai-result pre code {
  background: transparent;
  padding: 0;
}

#${CONFIG.overlayId} .hl-tm-ai-result blockquote {
  border-left: 3px solid rgba(131, 170, 240, 0.58);
  padding: 0.25em 0.75em;
  color: rgba(210, 224, 248, 0.9);
}

#${CONFIG.overlayId} .hl-tm-ai-result a {
  color: rgba(160, 202, 255, 0.96);
  text-decoration: underline;
}

#${CONFIG.overlayId} .hl-tm-ai-result table {
  width: 100%;
  border-collapse: collapse;
  display: block;
  overflow: auto;
}

#${CONFIG.overlayId} .hl-tm-ai-result th,
#${CONFIG.overlayId} .hl-tm-ai-result td {
  border: 1px solid rgba(157, 180, 222, 0.28);
  padding: 0.38em 0.52em;
  text-align: left;
}

#${CONFIG.overlayId} .hl-tm-ai-result.${AI_RESULT_VISIBLE_CLASS} {
  display: block;
}

@keyframes hl-tm-ai-spin {
  to {
    transform: rotate(1turn);
  }
}

@media (prefers-reduced-motion: reduce) {
  #${CONFIG.overlayId},
  #${CONFIG.overlayId} .hl-tm-preview-image,
  #${CONFIG.overlayId} .hl-tm-ai-action {
    transition: none !important;
  }

  #${CONFIG.overlayId} .hl-tm-ai-action.is-loading::after {
    animation: none;
  }
}
  `.trim();
    (document.head || document.documentElement).appendChild(style);
  }
  function applyTransform() {
    if (!refs.image) return;
    refs.image.style.transform = `translate3d(${state.translateX}px, ${state.translateY}px, 0) scale(${state.scale})`;
  }
  function resetTransform() {
    cancelScheduledDragTransform();
    const dragPointerId = state.activeDragPointerId;
    if (refs.image && dragPointerId !== null) {
      try {
        if (refs.image.hasPointerCapture(dragPointerId)) {
          refs.image.releasePointerCapture(dragPointerId);
        }
      } catch (error2) {
      }
    }
    state.scale = 1;
    state.translateX = 0;
    state.translateY = 0;
    state.dragging = false;
    state.activeDragPointerId = null;
    if (refs.overlay) refs.overlay.classList.remove("is-dragging");
    if (refs.image) refs.image.style.cursor = "grab";
    applyTransform();
  }
  function closePreview() {
    cancelActiveAiTask();
    latestAiRequestToken += 1;
    if (refs.overlay) {
      resetAiUi(refs.overlay);
    }
    state.isOpen = false;
    state.activeImageUrl = "";
    syncAiPanelAvailability(false);
    resetTransform();
    if (!refs.overlay) return;
    refs.overlay.classList.remove("is-open");
    refs.overlay.setAttribute("aria-hidden", "true");
    const imageRef = refs.image;
    window.setTimeout(() => {
      if (!state.isOpen && imageRef && imageRef === refs.image) {
        imageRef.removeAttribute("src");
      }
    }, CONFIG.animationDurationMs + 20);
  }
  function handleWheelZoom(event) {
    if (!state.isOpen || !refs.image) return;
    const target = event.target;
    if (target instanceof Element && target.closest(".hl-tm-ai-tools")) {
      return;
    }
    event.preventDefault();
    const oldScale = state.scale;
    const factor = event.deltaY < 0 ? 1 + CONFIG.zoomStep : 1 / (1 + CONFIG.zoomStep);
    const nextScale = clamp(oldScale * factor, CONFIG.minScale, CONFIG.maxScale);
    if (nextScale === oldScale) return;
    const rect = refs.image.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const offsetX = event.clientX - centerX;
    const offsetY = event.clientY - centerY;
    const ratio = nextScale / oldScale;
    state.translateX = state.translateX - offsetX * (ratio - 1);
    state.translateY = state.translateY - offsetY * (ratio - 1);
    state.scale = nextScale;
    applyTransform();
  }
  function handleDragStart(event) {
    if (!state.isOpen || !refs.image) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (state.activeDragPointerId !== null && state.activeDragPointerId !== event.pointerId) return;
    event.preventDefault();
    cancelScheduledDragTransform();
    state.dragging = true;
    state.activeDragPointerId = event.pointerId;
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.startTranslateX = state.translateX;
    state.startTranslateY = state.translateY;
    if (refs.overlay) refs.overlay.classList.add("is-dragging");
    refs.image.style.cursor = "grabbing";
    try {
      refs.image.setPointerCapture(event.pointerId);
    } catch (error2) {
    }
  }
  function handleDragMove(event) {
    if (!state.dragging || !state.isOpen) return;
    if (state.activeDragPointerId !== null && event.pointerId !== state.activeDragPointerId) return;
    event.preventDefault();
    const dx = event.clientX - state.dragStartX;
    const dy = event.clientY - state.dragStartY;
    state.translateX = state.startTranslateX + dx;
    state.translateY = state.startTranslateY + dy;
    scheduleDragTransformApply();
  }
  function handleDragEnd(event) {
    const pointerEvent = event instanceof PointerEvent ? event : null;
    if (!state.dragging) {
      if (pointerEvent && state.activeDragPointerId === pointerEvent.pointerId) {
        state.activeDragPointerId = null;
      }
      return;
    }
    if (pointerEvent && state.activeDragPointerId !== null && pointerEvent.pointerId !== state.activeDragPointerId) {
      return;
    }
    state.dragging = false;
    cancelScheduledDragTransform();
    applyTransform();
    if (refs.image && state.activeDragPointerId !== null) {
      try {
        if (refs.image.hasPointerCapture(state.activeDragPointerId)) {
          refs.image.releasePointerCapture(state.activeDragPointerId);
        }
      } catch (error2) {
      }
    }
    state.activeDragPointerId = null;
    if (refs.overlay) refs.overlay.classList.remove("is-dragging");
    if (refs.image) refs.image.style.cursor = "grab";
  }
  function createImageElement() {
    const image2 = document.createElement("img");
    image2.className = "hl-tm-preview-image";
    image2.alt = "Image Preview";
    image2.addEventListener("pointerdown", handleDragStart);
    image2.addEventListener("pointermove", handleDragMove);
    image2.addEventListener("pointerup", handleDragEnd);
    image2.addEventListener("pointercancel", handleDragEnd);
    image2.addEventListener("lostpointercapture", handleDragEnd);
    image2.addEventListener("dblclick", (event) => {
      event.preventDefault();
      resetTransform();
    });
    image2.addEventListener("dragstart", (event) => event.preventDefault());
    return image2;
  }
  function createAiToolsElement() {
    const tools = document.createElement("div");
    tools.className = "hl-tm-ai-tools";
    tools.innerHTML = `
<div class="hl-tm-ai-pill">
  <div class="hl-tm-ai-actions">
    <button class="hl-tm-ai-action" type="button" data-ai-task="explain">解释</button>
    <button class="hl-tm-ai-action" type="button" data-ai-task="translate">翻译</button>
  </div>
</div>
<p class="hl-tm-ai-status" data-role="ai-status" aria-live="polite"></p>
<div class="hl-tm-ai-result" data-role="ai-result" aria-live="polite" tabindex="0"></div>
  `.trim();
    return tools;
  }
  function createImageStageElement() {
    const stage = document.createElement("div");
    stage.className = "hl-tm-image-stage";
    const image2 = createImageElement();
    stage.appendChild(image2);
    stage.appendChild(createAiToolsElement());
    return { stage, image: image2 };
  }
  function createOverlay() {
    ensureStyle();
    let overlay = document.getElementById(CONFIG.overlayId);
    let stage = overlay?.querySelector(".hl-tm-image-stage") ?? null;
    let image2 = overlay?.querySelector(".hl-tm-preview-image") ?? null;
    const hasAiTools = Boolean(overlay?.querySelector(".hl-tm-ai-tools"));
    if (!overlay || !stage || !image2 || !hasAiTools) {
      overlay?.remove();
      overlay = document.createElement("div");
      overlay.id = CONFIG.overlayId;
      overlay.setAttribute("aria-hidden", "true");
      const createdStage = createImageStageElement();
      stage = createdStage.stage;
      image2 = createdStage.image;
      overlay.appendChild(stage);
    }
    if (!overlay.isConnected) {
      (document.documentElement || document.body).appendChild(overlay);
    }
    refs.overlay = overlay;
    refs.image = image2;
    if (overlay.dataset.bound !== "1") {
      overlay.dataset.bound = "1";
      overlay.addEventListener("click", (event) => {
        const target = event.target;
        if (target instanceof Element) {
          const aiTaskButton = target.closest("[data-ai-task]");
          const aiTaskType = parseAiTaskType(aiTaskButton?.dataset.aiTask);
          if (aiTaskButton && aiTaskType) {
            event.preventDefault();
            if (aiTaskButton.dataset.mode === AI_BUTTON_CLOSE_MODE) {
              closeAiTaskPanel(overlay, aiTaskType);
              return;
            }
            void runImageAiTask(aiTaskType, overlay);
            return;
          }
        }
        if (event.target === overlay) {
          closePreview();
        }
      });
      overlay.addEventListener("wheel", handleWheelZoom, { passive: false });
    }
    return overlay;
  }
  function openPreview(imageUrl) {
    const finalUrl = normalizeImageUrl(imageUrl);
    if (!finalUrl) return;
    createOverlay();
    if (!refs.overlay || !refs.image) return;
    state.isOpen = true;
    state.activeImageUrl = finalUrl;
    syncAiPanelAvailability(true);
    cancelActiveAiTask();
    latestAiRequestToken += 1;
    resetAiUi(refs.overlay);
    resetTransform();
    refs.image.src = finalUrl;
    refs.overlay.classList.add("is-open");
    refs.overlay.setAttribute("aria-hidden", "false");
  }
  function getReliableHoverElementFromEvent(event) {
    if (typeof event.composedPath === "function") {
      const path = event.composedPath();
      for (const node of path) {
        if (isElement(node)) return node;
      }
    }
    return isElement(event.target) ? event.target : null;
  }
  function updateHoveredElement(event) {
    const target = getReliableHoverElementFromEvent(event);
    if (!target) return;
    if (target.closest(`#${CONFIG.overlayId}`)) return;
    if (isAiPanelElement(target)) return;
    state.hoveredElement = target;
    if ("clientX" in event && typeof event.clientX === "number") {
      state.pointerX = event.clientX;
    }
    if ("clientY" in event && typeof event.clientY === "number") {
      state.pointerY = event.clientY;
    }
  }
  function handleKeydown(event) {
    if (event.key === "Escape") {
      state.lastCtrlKeydownAt = 0;
      if (state.isOpen) {
        event.preventDefault();
        closePreview();
        return;
      }
      if (state.aiPanelOpen) {
        event.preventDefault();
        closeAiPanel();
      }
      return;
    }
    const key = event.key.toLowerCase();
    const isToggleAiPanel = key === "a" && event.ctrlKey && event.shiftKey && !event.repeat;
    if (isToggleAiPanel) {
      if (shouldIgnoreHotkey(event)) return;
      state.lastCtrlKeydownAt = 0;
      event.preventDefault();
      toggleAiPanel();
      return;
    }
    if (event.key !== "Control") {
      state.lastCtrlKeydownAt = 0;
      return;
    }
    if (state.aiPanelOpen) {
      state.lastCtrlKeydownAt = 0;
      return;
    }
    if (shouldIgnoreHotkey(event)) {
      state.lastCtrlKeydownAt = 0;
      return;
    }
    if (!detectDoubleCtrl(event)) return;
    event.preventDefault();
    if (state.isOpen) {
      closePreview();
      return;
    }
    let candidate = state.hoveredElement;
    if (!isElement(candidate) && Number.isFinite(state.pointerX) && Number.isFinite(state.pointerY)) {
      candidate = document.elementFromPoint(state.pointerX, state.pointerY);
    }
    const imageUrl = getImageUrlFromElement(candidate);
    if (!imageUrl) {
      return;
    }
    openPreview(imageUrl);
  }
  function bindGlobalEvents() {
    if (state.globalEventsBound) return;
    state.globalEventsBound = true;
    document.addEventListener("pointerover", updateHoveredElement, true);
    document.addEventListener("pointermove", updateHoveredElement, true);
    document.addEventListener("mouseover", updateHoveredElement, true);
    document.addEventListener("keydown", handleKeydown, true);
    window.addEventListener("blur", handleDragEnd, true);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) handleDragEnd();
    });
  }
  function bootstrapHoverLens() {
    bindGlobalEvents();
    bootstrapAiPanel();
    createOverlay();
  }
  (() => {
    const globalWindow = window;
    if (globalWindow[INSTALL_GUARD_KEY]) return;
    globalWindow[INSTALL_GUARD_KEY] = true;
    try {
      bootstrapHoverLens();
    } catch (error2) {
    }
  })();

})();