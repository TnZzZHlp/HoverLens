import { INSTALL_GUARD_KEY } from "./config";
import { bootstrapHoverLens } from "./runtime";
import { logDebug } from "./utils";

(() => {
  const globalWindow = window as unknown as Record<string, unknown>;
  if (globalWindow[INSTALL_GUARD_KEY]) return;
  globalWindow[INSTALL_GUARD_KEY] = true;

  // 如需在 iframe 内也生效，可删除此判断
  if (window.top !== window.self) return;

  try {
    bootstrapHoverLens();
  } catch (error) {
    logDebug("HoverLens 初始化失败：", error);
  }
})();
