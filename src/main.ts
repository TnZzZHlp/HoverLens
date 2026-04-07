import { INSTALL_GUARD_KEY } from "./config";
import { bootstrapHoverLens } from "./runtime";
import { logDebug } from "./utils";

(() => {
  const globalWindow = window as unknown as Record<string, unknown>;
  if (globalWindow[INSTALL_GUARD_KEY]) return;
  globalWindow[INSTALL_GUARD_KEY] = true;

  try {
    bootstrapHoverLens();
  } catch (error) {
    logDebug("HoverLens 初始化失败：", error);
  }
})();
