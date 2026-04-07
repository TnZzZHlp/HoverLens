export interface ImageUrlContext {
  source: string;
  element?: Element | null;
}

export type ImageUrlResolverHook = (
  url: string,
  context: ImageUrlContext,
) => string | null | undefined;

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
}

export interface HoverLensRefs {
  overlay: HTMLDivElement | null;
  image: HTMLImageElement | null;
}
