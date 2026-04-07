export interface ImageUrlContext {
  source: string;
  element?: Element | null;
}

export type ImageUrlResolverHook = (
  url: string,
  context: ImageUrlContext,
) => string | null | undefined;

export type AiApiFormat = "openai-compatible" | "google-genai";

export interface AiConfig {
  enabled: boolean;
  apiFormat: AiApiFormat;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  enableGoogleSearchGrounding: boolean;
}

export type AiImageTaskType = "explain" | "translate";

export interface AiInlineImagePayload {
  mimeType: string;
  base64Data: string;
}

export interface HoverLensConfig {
  debug: boolean;
  doubleCtrlInterval: number;
  maxAncestorSearchDepth: number;
  descendantSearchDepth: number;
  minScale: number;
  maxScale: number;
  zoomStep: number;
  overlayZIndex: number;
  animationDurationMs: number;
  styleId: string;
  overlayId: string;
  aiPanelId: string;
  aiPanelToggleId: string;
  aiPanelStyleId: string;
  aiConfigStorageKey: string;
  defaultAiConfig: AiConfig;
  imageUrlResolverHook: ImageUrlResolverHook | null;
  editorBlockSelectors: string[];
}

export interface HoverLensState {
  hoveredElement: Element | null;
  pointerX: number;
  pointerY: number;

  isOpen: boolean;
  scale: number;
  translateX: number;
  translateY: number;

  dragging: boolean;
  dragStartX: number;
  dragStartY: number;
  startTranslateX: number;
  startTranslateY: number;

  activeImageUrl: string;
  lastCtrlKeydownAt: number;

  globalEventsBound: boolean;
  aiPanelOpen: boolean;
  aiConfig: AiConfig;
}

export interface HoverLensRefs {
  overlay: HTMLDivElement | null;
  image: HTMLImageElement | null;
  aiPanel: HTMLDivElement | null;
  aiPanelToggle: HTMLButtonElement | null;
}
