import { closeAiPanel, bootstrapAiPanel, isAiPanelElement, toggleAiPanel } from "./ai-panel";
import { CONFIG } from "./config";
import { detectDoubleCtrl, shouldIgnoreHotkey } from "./hotkey";
import { getImageUrlFromElement } from "./image";
import { closePreview, createOverlay, handleDragEnd, handleDragMove, openPreview } from "./overlay";
import { state } from "./state";
import { isElement, logDebug } from "./utils";

function getReliableHoverElementFromEvent(event: Event): Element | null {
  if (typeof event.composedPath === "function") {
    const path = event.composedPath();
    for (const node of path) {
      if (isElement(node)) return node;
    }
  }

  return isElement(event.target) ? event.target : null;
}

function updateHoveredElement(event: Event): void {
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

function handleKeydown(event: KeyboardEvent): void {
  // Esc: 无条件优先关闭预览
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

  // 非 Ctrl 键：重置双击计时，防止 Ctrl + 其他键误触
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

  // 若已打开：双击 Ctrl 关闭
  if (state.isOpen) {
    closePreview();
    return;
  }

  // 获取当前可信悬停元素（必要时回退 elementFromPoint）
  let candidate = state.hoveredElement;
  if (!isElement(candidate) && Number.isFinite(state.pointerX) && Number.isFinite(state.pointerY)) {
    candidate = document.elementFromPoint(state.pointerX, state.pointerY);
  }

  const imageUrl = getImageUrlFromElement(candidate);
  if (!imageUrl) {
    logDebug("未找到可预览图片，已忽略本次触发。", candidate);
    return;
  }

  openPreview(imageUrl);
}

function bindGlobalEvents(): void {
  if (state.globalEventsBound) return;
  state.globalEventsBound = true;

  // 悬停跟踪
  document.addEventListener("pointerover", updateHoveredElement, true);
  document.addEventListener("pointermove", updateHoveredElement, true);
  document.addEventListener("mouseover", updateHoveredElement, true); // 回退兼容

  // 快捷键监听
  document.addEventListener("keydown", handleKeydown, true);

  // 拖拽移动/结束
  window.addEventListener("mousemove", handleDragMove, true);
  window.addEventListener("mouseup", handleDragEnd, true);
  window.addEventListener("blur", handleDragEnd, true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) handleDragEnd();
  });
}

export function bootstrapHoverLens(): void {
  bindGlobalEvents();
  bootstrapAiPanel();
  createOverlay(); // 提前创建单例，避免首次触发时延迟
  logDebug("初始化完成");
}
