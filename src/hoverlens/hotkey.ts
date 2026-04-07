import { CONFIG } from "./config";
import { state } from "./state";
import { isElement } from "./utils";

const NATIVE_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="searchbox"]',
].join(",");

export function isEditableTarget(target: EventTarget | Element | null): boolean {
  if (!isElement(target)) return false;

  if (target.matches(NATIVE_EDITABLE_SELECTOR) || target.closest(NATIVE_EDITABLE_SELECTOR)) {
    return true;
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }

  // 常见编辑器区域
  for (const selector of CONFIG.editorBlockSelectors) {
    try {
      if (target.closest(selector)) return true;
    } catch {
      // 忽略异常选择器
    }
  }

  return false;
}

export function shouldIgnoreHotkey(event: KeyboardEvent): boolean {
  // 避免与系统/浏览器快捷键组合产生误触
  if (event.altKey || event.metaKey) return true;

  const activeEl = document.activeElement;
  if (isEditableTarget(event.target) || isEditableTarget(activeEl)) {
    return true;
  }

  return false;
}

export function detectDoubleCtrl(event: KeyboardEvent): boolean {
  if (event.key !== "Control") return false;
  if (event.repeat) return false; // 长按防抖

  const now = performance.now();
  const isDouble =
    state.lastCtrlKeydownAt > 0 && now - state.lastCtrlKeydownAt <= CONFIG.doubleCtrlInterval;

  state.lastCtrlKeydownAt = now;
  return isDouble;
}
