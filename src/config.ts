import type { HoverLensConfig } from './types';

export const INSTALL_GUARD_KEY = '__HOVERLENS_TM_INSTALLED__' as const;

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

  styleId: 'hl-tm-style',
  overlayId: 'hl-tm-overlay',

  // 可扩展：用于把缩略图 URL 映射成原图 URL（当前默认透传）
  // imageUrlResolverHook: (url, context) => url
  imageUrlResolverHook: null,

  editorBlockSelectors: [
    '.monaco-editor',
    '.monaco-workbench',
    '.CodeMirror',
    '.cm-editor',
    '.ace_editor',
    '.ql-editor',
    '.ProseMirror',
    '[data-testid*="editor"]',
    '[class*="monaco-editor"]',
    '[class*="CodeMirror"]',
    '[class*="cm-editor"]',
  ],
};
