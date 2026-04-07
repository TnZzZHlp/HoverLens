import { generateImageTaskStreamWithConfiguredAi } from "./ai-client";
import { syncAiPanelAvailability } from "./ai-panel";
import { CONFIG } from "./config";
import MarkdownIt from "markdown-it";
import { refs, state } from "./state";
import type { AiImageTaskType, AiInlineImagePayload } from "./types";
import { clamp, logDebug, normalizeImageUrl } from "./utils";

const AI_RESULT_VISIBLE_CLASS = "is-visible";
const AI_STATUS_ERROR_CLASS = "is-error";
const AI_BUTTON_LOADING_CLASS = "is-loading";
const AI_BUTTON_CLOSE_CLASS = "is-close";
const AI_BUTTON_CLOSE_MODE = "close";

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

let latestAiRequestToken = 0;
let dragTransformRafId = 0;
let activeAiTaskAbortController: AbortController | null = null;

interface OverlayAiElements {
  explainButton: HTMLButtonElement;
  translateButton: HTMLButtonElement;
  status: HTMLParagraphElement;
  result: HTMLDivElement;
}

function getAiTaskButtonLabel(taskType: AiImageTaskType): string {
  return taskType === "explain" ? "解释" : "翻译";
}

function getButtonTaskType(button: HTMLButtonElement): AiImageTaskType {
  return button.dataset.aiTask === "translate" ? "translate" : "explain";
}

function setAiTaskButtonCloseMode(button: HTMLButtonElement, enabled: boolean): void {
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

function resetAiTaskButtonModes(elements: OverlayAiElements): void {
  setAiTaskButtonCloseMode(elements.explainButton, false);
  setAiTaskButtonCloseMode(elements.translateButton, false);
}

function markAiTaskButtonAsClose(elements: OverlayAiElements, taskType: AiImageTaskType): void {
  const targetButton = taskType === "explain" ? elements.explainButton : elements.translateButton;
  const otherButton = taskType === "explain" ? elements.translateButton : elements.explainButton;

  setAiTaskButtonCloseMode(targetButton, true);
  setAiTaskButtonCloseMode(otherButton, false);
}

function parseAiTaskType(rawValue: string | undefined): AiImageTaskType | null {
  if (rawValue === "explain" || rawValue === "translate") {
    return rawValue;
  }

  return null;
}

function getAiTaskLoadingMessage(taskType: AiImageTaskType): string {
  return taskType === "explain" ? "正在解释图片…" : "正在识别并翻译图片文字…";
}

function getAiTaskSuccessMessage(taskType: AiImageTaskType): string {
  return taskType === "explain" ? "图片解释完成。" : "图片翻译完成。";
}

function inferMimeTypeFromUrl(imageUrl: string): string {
  const cleanUrl = imageUrl.split("?")[0].split("#")[0].toLowerCase();

  if (cleanUrl.endsWith(".png")) return "image/png";
  if (cleanUrl.endsWith(".webp")) return "image/webp";
  if (cleanUrl.endsWith(".gif")) return "image/gif";
  if (cleanUrl.endsWith(".bmp")) return "image/bmp";
  if (cleanUrl.endsWith(".svg")) return "image/svg+xml";
  if (cleanUrl.endsWith(".jpg") || cleanUrl.endsWith(".jpeg")) return "image/jpeg";

  return "image/jpeg";
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("图片编码失败。"));
    };

    reader.onerror = () => {
      reject(new Error("图片编码失败。"));
    };

    reader.readAsDataURL(blob);
  });
}

async function fetchInlineImagePayload(imageUrl: string): Promise<AiInlineImagePayload> {
  let response: Response;

  try {
    response = await fetch(imageUrl, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
    });
  } catch {
    throw new Error("无法读取图片内容，可能被站点跨域限制。请尝试在新标签页打开图片后再试。");
  }

  if (!response.ok) {
    throw new Error(`图片加载失败（HTTP ${response.status}）。`);
  }

  const imageBlob = await response.blob();
  if (imageBlob.size <= 0) {
    throw new Error("图片数据为空，无法解析。");
  }

  const mimeType = imageBlob.type || inferMimeTypeFromUrl(imageUrl);
  if (!/^image\//i.test(mimeType)) {
    throw new Error("当前资源不是有效图片格式，暂不支持解释/翻译。");
  }

  const dataUrl = await blobToDataUrl(imageBlob);
  const commaIndex = dataUrl.indexOf(",");
  const base64Data = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1).trim() : "";

  if (!base64Data) {
    throw new Error("图片编码失败，未获取到有效数据。");
  }

  return {
    mimeType,
    base64Data,
  };
}

function getOverlayAiElements(overlay: HTMLDivElement): OverlayAiElements | null {
  const explainButton = overlay.querySelector<HTMLButtonElement>('[data-ai-task="explain"]');
  const translateButton = overlay.querySelector<HTMLButtonElement>('[data-ai-task="translate"]');
  const status = overlay.querySelector<HTMLParagraphElement>('[data-role="ai-status"]');
  const result = overlay.querySelector<HTMLDivElement>('[data-role="ai-result"]');

  if (!explainButton || !translateButton || !status || !result) {
    return null;
  }

  return {
    explainButton,
    translateButton,
    status,
    result,
  };
}

function setAiLoadingState(
  elements: OverlayAiElements,
  loading: boolean,
  taskType?: AiImageTaskType,
): void {
  const isExplainLoading = loading && taskType === "explain";
  const isTranslateLoading = loading && taskType === "translate";

  elements.explainButton.disabled = loading;
  elements.translateButton.disabled = loading;
  elements.explainButton.classList.toggle(AI_BUTTON_LOADING_CLASS, isExplainLoading);
  elements.translateButton.classList.toggle(AI_BUTTON_LOADING_CLASS, isTranslateLoading);
}

function setAiStatus(elements: OverlayAiElements, message: string, isError = false): void {
  elements.status.textContent = message;
  elements.status.classList.toggle(AI_STATUS_ERROR_CLASS, isError);
}

function setAiResult(elements: OverlayAiElements, message: string): void {
  const safeMessage = message.trim();

  if (!safeMessage) {
    elements.result.innerHTML = "";
    elements.result.classList.remove(AI_RESULT_VISIBLE_CLASS);
    return;
  }

  try {
    elements.result.innerHTML = markdownRenderer.render(safeMessage);
  } catch (error) {
    logDebug("Markdown 渲染失败，已回退纯文本：", error);
    elements.result.textContent = safeMessage;
  }

  elements.result.classList.add(AI_RESULT_VISIBLE_CLASS);
}

function cancelScheduledDragTransform(): void {
  if (!dragTransformRafId) return;

  window.cancelAnimationFrame(dragTransformRafId);
  dragTransformRafId = 0;
}

function scheduleDragTransformApply(): void {
  if (dragTransformRafId) return;

  dragTransformRafId = window.requestAnimationFrame(() => {
    dragTransformRafId = 0;
    applyTransform();
  });
}

function cancelActiveAiTask(): void {
  if (!activeAiTaskAbortController) return;

  activeAiTaskAbortController.abort();
  activeAiTaskAbortController = null;
}

function resetAiUi(overlay: HTMLDivElement): void {
  const elements = getOverlayAiElements(overlay);
  if (!elements) return;

  setAiLoadingState(elements, false);
  resetAiTaskButtonModes(elements);
  setAiStatus(elements, "");
  setAiResult(elements, "");
}

function closeAiTaskPanel(overlay: HTMLDivElement, taskType: AiImageTaskType): void {
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

async function runImageAiTask(taskType: AiImageTaskType, overlay: HTMLDivElement): Promise<void> {
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
      },
    });
    if (requestToken !== latestAiRequestToken) return;

    setAiResult(elements, aiResult || "模型未返回文本结果。");
    setAiStatus(elements, getAiTaskSuccessMessage(taskType));
    markAiTaskButtonAsClose(elements, taskType);
  } catch (error) {
    if (requestToken !== latestAiRequestToken) return;

    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }

    const errorMessage =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "AI 请求失败，请稍后重试。";

    logDebug("图片 AI 操作失败：", error);
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

function ensureStyle(): void {
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
  width: min(520px, calc(100vw - 20px));
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

export function applyTransform(): void {
  if (!refs.image) return;
  refs.image.style.transform = `translate3d(${state.translateX}px, ${state.translateY}px, 0) scale(${state.scale})`;
}

export function resetTransform(): void {
  cancelScheduledDragTransform();

  const dragPointerId = state.activeDragPointerId;
  if (refs.image && dragPointerId !== null) {
    try {
      if (refs.image.hasPointerCapture(dragPointerId)) {
        refs.image.releasePointerCapture(dragPointerId);
      }
    } catch (error) {
      logDebug("resetTransform 释放 pointer capture 失败：", error);
    }
  }

  state.scale = 1;
  state.translateX = 0;
  state.translateY = 0;
  state.dragging = false;
  state.activeDragPointerId = null;

  if (refs.overlay) refs.overlay.classList.remove("is-dragging");
  if (refs.image) refs.image.style.cursor = "grab";

  // 关闭或切换图片时立即把样式同步回默认缩放/位移
  applyTransform();
}

export function closePreview(): void {
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

  // 延迟清理 src，避免关闭动画期间闪烁
  const imageRef = refs.image;
  window.setTimeout(() => {
    if (!state.isOpen && imageRef && imageRef === refs.image) {
      imageRef.removeAttribute("src");
    }
  }, CONFIG.animationDurationMs + 20);
}

export function handleWheelZoom(event: WheelEvent): void {
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

  // 以鼠标位置为缩放焦点，减小“跳变感”
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

export function handleDragStart(event: PointerEvent): void {
  if (!state.isOpen || !refs.image) return;

  // 鼠标仅允许左键，触控/触笔放行
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
  } catch (error) {
    logDebug("setPointerCapture 失败，继续使用常规拖动：", error);
  }
}

export function handleDragMove(event: PointerEvent): void {
  if (!state.dragging || !state.isOpen) return;
  if (state.activeDragPointerId !== null && event.pointerId !== state.activeDragPointerId) return;

  event.preventDefault();

  const dx = event.clientX - state.dragStartX;
  const dy = event.clientY - state.dragStartY;

  state.translateX = state.startTranslateX + dx;
  state.translateY = state.startTranslateY + dy;

  scheduleDragTransformApply();
}

export function handleDragEnd(event?: Event): void {
  const pointerEvent = event instanceof PointerEvent ? event : null;

  if (!state.dragging) {
    if (pointerEvent && state.activeDragPointerId === pointerEvent.pointerId) {
      state.activeDragPointerId = null;
    }

    return;
  }

  if (
    pointerEvent &&
    state.activeDragPointerId !== null &&
    pointerEvent.pointerId !== state.activeDragPointerId
  ) {
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
    } catch (error) {
      logDebug("releasePointerCapture 失败：", error);
    }
  }

  state.activeDragPointerId = null;

  if (refs.overlay) refs.overlay.classList.remove("is-dragging");
  if (refs.image) refs.image.style.cursor = "grab";
}

function createImageElement(): HTMLImageElement {
  const image = document.createElement("img");
  image.className = "hl-tm-preview-image";
  image.alt = "Image Preview";

  image.addEventListener("pointerdown", handleDragStart);
  image.addEventListener("pointermove", handleDragMove);
  image.addEventListener("pointerup", handleDragEnd);
  image.addEventListener("pointercancel", handleDragEnd);
  image.addEventListener("lostpointercapture", handleDragEnd);
  image.addEventListener("dblclick", (event) => {
    event.preventDefault();
    resetTransform();
  });
  image.addEventListener("dragstart", (event) => event.preventDefault());

  return image;
}

function createAiToolsElement(): HTMLDivElement {
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

function createImageStageElement(): { stage: HTMLDivElement; image: HTMLImageElement } {
  const stage = document.createElement("div");
  stage.className = "hl-tm-image-stage";

  const image = createImageElement();
  stage.appendChild(image);
  stage.appendChild(createAiToolsElement());

  return { stage, image };
}

export function createOverlay(): HTMLDivElement {
  ensureStyle();

  let overlay = document.getElementById(CONFIG.overlayId) as HTMLDivElement | null;
  let stage = overlay?.querySelector<HTMLDivElement>(".hl-tm-image-stage") ?? null;
  let image = overlay?.querySelector<HTMLImageElement>(".hl-tm-preview-image") ?? null;
  const hasAiTools = Boolean(overlay?.querySelector<HTMLElement>(".hl-tm-ai-tools"));

  if (!overlay || !stage || !image || !hasAiTools) {
    overlay?.remove();

    overlay = document.createElement("div");
    overlay.id = CONFIG.overlayId;
    overlay.setAttribute("aria-hidden", "true");

    const createdStage = createImageStageElement();
    stage = createdStage.stage;
    image = createdStage.image;
    overlay.appendChild(stage);
  }

  if (!overlay.isConnected) {
    (document.documentElement || document.body).appendChild(overlay);
  }

  refs.overlay = overlay;
  refs.image = image;

  if (overlay.dataset.bound !== "1") {
    overlay.dataset.bound = "1";

    overlay.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Element) {
        const aiTaskButton = target.closest<HTMLButtonElement>("[data-ai-task]");
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

export function openPreview(imageUrl: string): void {
  const finalUrl = normalizeImageUrl(imageUrl, { source: "openPreview" });
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
