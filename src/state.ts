import type { HoverLensRefs, HoverLensState } from './types';

export const state: HoverLensState = {
  hoveredElement: null,
  pointerX: Number.NaN,
  pointerY: Number.NaN,

  isOpen: false,
  scale: 1,
  translateX: 0,
  translateY: 0,

  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  startTranslateX: 0,
  startTranslateY: 0,

  activeImageUrl: '',
  lastCtrlKeydownAt: 0,

  globalEventsBound: false,
};

export const refs: HoverLensRefs = {
  overlay: null,
  image: null,
};
