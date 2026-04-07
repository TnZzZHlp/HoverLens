import { GM_addValueChangeListener, GM_getValue, GM_setValue } from "$";
import { CONFIG } from "./config";
import { refs, state } from "./state";
import type { AiApiFormat, AiConfig } from "./types";
import { clamp, logDebug } from "./utils";

const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const SYSTEM_PROMPT_MAX_LENGTH = 4000;
const MAX_SAFE_Z_INDEX = 2147483647;
const AI_PANEL_Z_INDEX = Math.min(CONFIG.overlayZIndex + 1, MAX_SAFE_Z_INDEX);
const AI_TOGGLE_Z_INDEX = Math.min(CONFIG.overlayZIndex + 2, MAX_SAFE_Z_INDEX);
const AI_TOGGLE_VISIBLE_CLASS = "is-visible";

type AiPanelControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface AiPanelFormElements {
  enabled: HTMLInputElement;
  apiFormat: HTMLSelectElement;
  apiFormatNote: HTMLParagraphElement;
  provider: HTMLInputElement;
  baseUrl: HTMLInputElement;
  apiKey: HTMLInputElement;
  apiKeyToggle: HTMLButtonElement;
  model: HTMLInputElement;
  temperature: HTMLInputElement;
  temperatureValue: HTMLSpanElement;
  systemPrompt: HTMLTextAreaElement;
  enableGoogleSearchGrounding: HTMLInputElement;
  saveButton: HTMLButtonElement;
  status: HTMLParagraphElement;
}

function cloneDefaultAiConfig(): AiConfig {
  return { ...CONFIG.defaultAiConfig };
}

function sanitizeText(value: unknown, fallback: string, allowEmpty = false): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (allowEmpty) return trimmed;
  return trimmed || fallback;
}

function normalizeApiFormat(value: unknown): AiApiFormat {
  if (value === "openai-compatible" || value === "google-genai") {
    return value;
  }

  return CONFIG.defaultAiConfig.apiFormat;
}

function normalizeAiConfig(raw: unknown): AiConfig {
  const next = cloneDefaultAiConfig();
  if (!raw || typeof raw !== "object") return next;

  const payload = raw as Partial<Record<keyof AiConfig, unknown>>;

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

function isSameAiConfig(left: AiConfig, right: AiConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.apiFormat === right.apiFormat &&
    left.provider === right.provider &&
    left.baseUrl === right.baseUrl &&
    left.apiKey === right.apiKey &&
    left.model === right.model &&
    Math.abs(left.temperature - right.temperature) <= Number.EPSILON &&
    left.systemPrompt === right.systemPrompt &&
    left.enableGoogleSearchGrounding === right.enableGoogleSearchGrounding
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function clearControlValidation(control: AiPanelControl): void {
  control.classList.remove("is-invalid");
  control.removeAttribute("aria-invalid");
}

function markControlInvalid(control: AiPanelControl): void {
  control.classList.add("is-invalid");
  control.setAttribute("aria-invalid", "true");
}

function clearValidationState(panel: HTMLDivElement): void {
  const controls = panel.querySelectorAll<AiPanelControl>(".hl-ai-control");
  controls.forEach(clearControlValidation);
}

function validateDraftConfig(panel: HTMLDivElement, config: AiConfig): string | null {
  const elements = getFormElements(panel);
  if (!elements) return "表单元素异常，暂时无法保存。";

  clearValidationState(panel);

  if (config.baseUrl && !isHttpUrl(config.baseUrl)) {
    markControlInvalid(elements.baseUrl);
    return "Base URL 必须是合法的 http(s) 地址。";
  }

  if (!config.enabled) {
    return null;
  }

  if (!config.apiKey) {
    markControlInvalid(elements.apiKey);
    return "已启用 AI，请先填写 API Key。";
  }

  if (config.apiFormat === "openai-compatible") {
    markControlInvalid(elements.apiFormat);
    return "openai-compatible 尚未接入请求通道，请改用 Google GenAI。";
  }

  return null;
}

function decodePersistedAiConfig(raw: unknown): AiConfig {
  if (typeof raw === "string") {
    try {
      return normalizeAiConfig(JSON.parse(raw) as unknown);
    } catch {
      return cloneDefaultAiConfig();
    }
  }

  return normalizeAiConfig(raw);
}

function loadAiConfigFromLocalStorage(): AiConfig {
  try {
    const raw = window.localStorage.getItem(CONFIG.aiConfigStorageKey);
    if (!raw) return cloneDefaultAiConfig();

    const parsed = JSON.parse(raw) as unknown;
    return normalizeAiConfig(parsed);
  } catch (error) {
    logDebug("AI 配置读取失败，已回退默认值：", error);
    return cloneDefaultAiConfig();
  }
}

function saveAiConfigToLocalStorage(config: AiConfig): boolean {
  try {
    window.localStorage.setItem(CONFIG.aiConfigStorageKey, JSON.stringify(config));
    return true;
  } catch (error) {
    logDebug("AI 配置保存失败：", error);
    return false;
  }
}

function loadAiConfigFromStorage(): AiConfig {
  if (typeof GM_getValue === "function") {
    try {
      const gmRaw = GM_getValue<unknown>(CONFIG.aiConfigStorageKey);
      if (typeof gmRaw !== "undefined") {
        return decodePersistedAiConfig(gmRaw);
      }

      // 兼容历史版本：首次切到 GM 存储时，尝试读取并迁移 LocalStorage 数据
      const legacyConfig = loadAiConfigFromLocalStorage();
      if (typeof GM_setValue === "function") {
        GM_setValue(CONFIG.aiConfigStorageKey, legacyConfig);
      }
      return legacyConfig;
    } catch (error) {
      logDebug("AI 配置读取 GM 存储失败，已回退 LocalStorage：", error);
    }
  }

  return loadAiConfigFromLocalStorage();
}

function saveAiConfigToStorage(config: AiConfig): boolean {
  if (typeof GM_setValue === "function") {
    try {
      GM_setValue(CONFIG.aiConfigStorageKey, config);
      return true;
    } catch (error) {
      logDebug("AI 配置写入 GM 存储失败，已回退 LocalStorage：", error);
    }
  }

  return saveAiConfigToLocalStorage(config);
}

function ensureAiPanelStyle(): void {
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

function createPanelElement(): HTMLDivElement {
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

function createToggleButtonElement(): HTMLButtonElement {
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

function getFormElements(panel: HTMLDivElement): AiPanelFormElements | null {
  const enabled = panel.querySelector<HTMLInputElement>('input[name="enabled"]');
  const apiFormat = panel.querySelector<HTMLSelectElement>('select[name="apiFormat"]');
  const apiFormatNote = panel.querySelector<HTMLParagraphElement>('[data-role="api-format-note"]');
  const provider = panel.querySelector<HTMLInputElement>('input[name="provider"]');
  const baseUrl = panel.querySelector<HTMLInputElement>('input[name="baseUrl"]');
  const apiKey = panel.querySelector<HTMLInputElement>('input[name="apiKey"]');
  const apiKeyToggle = panel.querySelector<HTMLButtonElement>('[data-role="api-key-toggle"]');
  const model = panel.querySelector<HTMLInputElement>('input[name="model"]');
  const temperature = panel.querySelector<HTMLInputElement>('input[name="temperature"]');
  const temperatureValue = panel.querySelector<HTMLSpanElement>('[data-role="temperature-value"]');
  const systemPrompt = panel.querySelector<HTMLTextAreaElement>('textarea[name="systemPrompt"]');
  const enableGoogleSearchGrounding = panel.querySelector<HTMLInputElement>(
    'input[name="enableGoogleSearchGrounding"]',
  );
  const saveButton = panel.querySelector<HTMLButtonElement>('[data-role="save"]');
  const status = panel.querySelector<HTMLParagraphElement>('[data-role="status"]');

  if (
    !enabled ||
    !apiFormat ||
    !apiFormatNote ||
    !provider ||
    !baseUrl ||
    !apiKey ||
    !apiKeyToggle ||
    !model ||
    !temperature ||
    !temperatureValue ||
    !systemPrompt ||
    !enableGoogleSearchGrounding ||
    !saveButton ||
    !status
  ) {
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
    status,
  };
}

function syncGoogleGroundingFieldState(panel: HTMLDivElement): void {
  const elements = getFormElements(panel);
  if (!elements) return;

  const wrapper = panel.querySelector<HTMLElement>('[data-role="google-grounding-row"]');
  if (!wrapper) return;

  const isGoogleGenAi = elements.apiFormat.value === "google-genai";
  if (!isGoogleGenAi) {
    elements.enableGoogleSearchGrounding.checked = false;
  }

  elements.enableGoogleSearchGrounding.disabled = !isGoogleGenAi;
  wrapper.classList.toggle("is-disabled", !isGoogleGenAi);
  wrapper.title = isGoogleGenAi
    ? "开启后会按 Google GenAI 的 tools 格式附带 googleSearch。"
    : "仅 Google GenAI 格式支持该选项。";
}

function syncApiFormatNotice(panel: HTMLDivElement): void {
  const elements = getFormElements(panel);
  if (!elements) return;

  const isOpenAiCompatible = elements.apiFormat.value === "openai-compatible";
  elements.apiFormatNote.textContent = isOpenAiCompatible
    ? "提示：openai-compatible 在当前版本尚未接入请求通道。"
    : "";
  elements.apiFormatNote.classList.toggle("is-warning", isOpenAiCompatible);
}

function setApiKeyVisibility(panel: HTMLDivElement, visible: boolean): void {
  const elements = getFormElements(panel);
  if (!elements) return;

  elements.apiKey.type = visible ? "text" : "password";
  elements.apiKeyToggle.textContent = visible ? "隐藏密钥" : "显示密钥";
  elements.apiKeyToggle.setAttribute("aria-pressed", visible ? "true" : "false");
  elements.apiKeyToggle.title = visible ? "隐藏密钥" : "显示密钥";
}

function syncSaveButtonState(panel: HTMLDivElement): void {
  const elements = getFormElements(panel);
  if (!elements) return;

  const draftConfig = readForm(panel);
  if (!draftConfig) {
    elements.saveButton.disabled = true;
    return;
  }

  elements.saveButton.disabled = isSameAiConfig(draftConfig, state.aiConfig);
}

function updateTemperatureLabel(elements: AiPanelFormElements): void {
  const value = Number.parseFloat(elements.temperature.value);
  const safeValue = Number.isFinite(value) ? clamp(value, TEMPERATURE_MIN, TEMPERATURE_MAX) : 0;
  elements.temperatureValue.textContent = safeValue.toFixed(1);
}

function fillForm(panel: HTMLDivElement, config: AiConfig): void {
  const elements = getFormElements(panel);
  if (!elements) return;

  elements.enabled.checked = config.enabled;
  elements.apiFormat.value = config.apiFormat;
  elements.provider.value = config.provider;
  elements.baseUrl.value = config.baseUrl;
  elements.apiKey.value = config.apiKey;
  elements.model.value = config.model;
  elements.temperature.value = String(clamp(config.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX));
  elements.systemPrompt.value = config.systemPrompt;
  elements.enableGoogleSearchGrounding.checked = config.enableGoogleSearchGrounding;
  elements.status.textContent = "";
  elements.status.classList.remove("is-error");

  clearValidationState(panel);
  setApiKeyVisibility(panel, false);
  updateTemperatureLabel(elements);
  syncGoogleGroundingFieldState(panel);
  syncApiFormatNotice(panel);
  syncSaveButtonState(panel);
}

function readForm(panel: HTMLDivElement): AiConfig | null {
  const elements = getFormElements(panel);
  if (!elements) return null;

  const temperatureValue = Number.parseFloat(elements.temperature.value);
  const temperature = Number.isFinite(temperatureValue)
    ? clamp(temperatureValue, TEMPERATURE_MIN, TEMPERATURE_MAX)
    : CONFIG.defaultAiConfig.temperature;

  return {
    enabled: elements.enabled.checked,
    apiFormat: normalizeApiFormat(elements.apiFormat.value),
    provider: sanitizeText(elements.provider.value, CONFIG.defaultAiConfig.provider),
    baseUrl: sanitizeText(elements.baseUrl.value, CONFIG.defaultAiConfig.baseUrl),
    apiKey: sanitizeText(elements.apiKey.value, "", true),
    model: sanitizeText(elements.model.value, CONFIG.defaultAiConfig.model),
    temperature,
    systemPrompt: sanitizeText(elements.systemPrompt.value, "", true),
    enableGoogleSearchGrounding: elements.enableGoogleSearchGrounding.checked,
  };
}

function setStatus(panel: HTMLDivElement, message: string, isError = false): void {
  const elements = getFormElements(panel);
  if (!elements) return;

  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", isError);
}

function setPanelOpen(open: boolean): void {
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

    const providerInput = panel.querySelector<HTMLInputElement>('input[name="provider"]');
    providerInput?.focus();
  }
}

function setToggleButtonVisible(visible: boolean): void {
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

function bindPanelEvents(panel: HTMLDivElement): void {
  if (panel.dataset.bound === "1") return;
  panel.dataset.bound = "1";

  panel.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const actionEl = target.closest<HTMLElement>("[data-action]");
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
    const handleDraftChange = (event: Event): void => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
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

function bindToggleButtonEvents(button: HTMLButtonElement): void {
  if (button.dataset.bound === "1") return;
  button.dataset.bound = "1";

  button.addEventListener("click", (event) => {
    event.preventDefault();
    toggleAiPanel();
  });
}

export function closeAiPanel(): void {
  setPanelOpen(false);
}

export function toggleAiPanel(force?: boolean): void {
  if (!state.isOpen) {
    setPanelOpen(false);
    return;
  }

  const next = typeof force === "boolean" ? force : !state.aiPanelOpen;
  setPanelOpen(next);
}

export function syncAiPanelAvailability(previewOpen: boolean): void {
  const shouldShow = previewOpen && state.isOpen;

  if (!shouldShow && state.aiPanelOpen) {
    setPanelOpen(false);
  }

  setToggleButtonVisible(shouldShow);
}

export function isAiPanelElement(target: Element | null): boolean {
  if (!target) return false;

  if (refs.aiPanel && refs.aiPanel.contains(target)) return true;
  if (refs.aiPanelToggle && refs.aiPanelToggle.contains(target)) return true;

  return false;
}

export function bootstrapAiPanel(): void {
  ensureAiPanelStyle();

  state.aiConfig = loadAiConfigFromStorage();

  let panel = document.getElementById(CONFIG.aiPanelId) as HTMLDivElement | null;
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

  let toggleButton = document.getElementById(CONFIG.aiPanelToggleId) as HTMLButtonElement | null;
  if (!(toggleButton instanceof HTMLButtonElement)) {
    toggleButton = createToggleButtonElement();
  }

  if (!toggleButton.isConnected) {
    (document.documentElement || document.body).appendChild(toggleButton);
  }

  refs.aiPanel = panel;
  refs.aiPanelToggle = toggleButton;

  // 基线兜底：初始化时先强制隐藏，避免历史 DOM 状态导致误显示
  setToggleButtonVisible(false);

  bindPanelEvents(panel);
  bindToggleButtonEvents(toggleButton);

  fillForm(panel, state.aiConfig);
  syncAiPanelAvailability(state.isOpen);

  if (typeof GM_addValueChangeListener === "function") {
    GM_addValueChangeListener<unknown>(
      CONFIG.aiConfigStorageKey,
      (_key, _oldValue, newValue, remote) => {
        if (!remote) return;

        state.aiConfig = decodePersistedAiConfig(newValue);
        if (state.aiPanelOpen && refs.aiPanel) {
          fillForm(refs.aiPanel, state.aiConfig);
        }
      },
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

  logDebug("AI 配置面板已初始化");
}
