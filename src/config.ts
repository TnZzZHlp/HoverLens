import type { HoverLensConfig } from "./types";

export const INSTALL_GUARD_KEY = "__HOVERLENS_TM_INSTALLED__" as const;

export const CONFIG: HoverLensConfig = {
  debug: false,

  // 双击 Ctrl 判定窗口（ms）
  doubleCtrlInterval: 360,

  // 悬停元素向上查找祖先层级
  maxAncestorSearchDepth: 8,

  // 仅在较近祖先上查找内部 img，避免对超大容器全量扫描
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
    enableGoogleSearchGrounding: true,
  },

  // 可扩展：用于把缩略图 URL 映射成原图 URL（当前默认透传）
  // imageUrlResolverHook: (url, context) => url
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
    '[class*="cm-editor"]',
  ],
};
