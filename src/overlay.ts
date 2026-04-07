import { CONFIG } from "./config";
import { refs, state } from "./state";
import { clamp, normalizeImageUrl } from "./utils";

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
  will-change: transform;
}

#${CONFIG.overlayId}.is-dragging .hl-tm-preview-image {
  cursor: grabbing;
}

@media (prefers-reduced-motion: reduce) {
  #${CONFIG.overlayId},
  #${CONFIG.overlayId} .hl-tm-preview-image {
    transition: none !important;
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
  state.scale = 1;
  state.translateX = 0;
  state.translateY = 0;
  state.dragging = false;

  if (refs.overlay) refs.overlay.classList.remove("is-dragging");
  if (refs.image) refs.image.style.cursor = "grab";

  // 关闭或切换图片时立即把样式同步回默认缩放/位移
  applyTransform();
}

export function closePreview(): void {
  if (!refs.overlay) return;

  state.isOpen = false;
  state.activeImageUrl = "";
  resetTransform();

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

export function handleDragStart(event: MouseEvent): void {
  if (!state.isOpen || !refs.image) return;
  if (event.button !== 0) return; // 仅左键拖动

  event.preventDefault();

  state.dragging = true;
  state.dragStartX = event.clientX;
  state.dragStartY = event.clientY;
  state.startTranslateX = state.translateX;
  state.startTranslateY = state.translateY;

  if (refs.overlay) refs.overlay.classList.add("is-dragging");
  refs.image.style.cursor = "grabbing";
}

export function handleDragMove(event: MouseEvent): void {
  if (!state.dragging || !state.isOpen) return;

  event.preventDefault();

  const dx = event.clientX - state.dragStartX;
  const dy = event.clientY - state.dragStartY;

  state.translateX = state.startTranslateX + dx;
  state.translateY = state.startTranslateY + dy;

  applyTransform();
}

export function handleDragEnd(): void {
  if (!state.dragging) return;

  state.dragging = false;
  if (refs.overlay) refs.overlay.classList.remove("is-dragging");
  if (refs.image) refs.image.style.cursor = "grab";
}

function createImageElement(): HTMLImageElement {
  const image = document.createElement("img");
  image.className = "hl-tm-preview-image";
  image.alt = "Image Preview";

  image.addEventListener("mousedown", handleDragStart);
  image.addEventListener("dblclick", (event) => {
    event.preventDefault();
    resetTransform();
  });
  image.addEventListener("dragstart", (event) => event.preventDefault());

  return image;
}

export function createOverlay(): HTMLDivElement {
  ensureStyle();

  let overlay = document.getElementById(CONFIG.overlayId) as HTMLDivElement | null;
  let image = overlay?.querySelector<HTMLImageElement>(".hl-tm-preview-image") ?? null;

  if (!overlay || !image) {
    overlay = document.createElement("div");
    overlay.id = CONFIG.overlayId;
    overlay.setAttribute("aria-hidden", "true");

    image = createImageElement();
    overlay.appendChild(image);
  }

  if (!overlay.isConnected) {
    (document.documentElement || document.body).appendChild(overlay);
  }

  refs.overlay = overlay;
  refs.image = image;

  if (overlay.dataset.bound !== "1") {
    overlay.dataset.bound = "1";

    overlay.addEventListener("click", (event) => {
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

  resetTransform();
  refs.image.src = finalUrl;
  refs.overlay.classList.add("is-open");
  refs.overlay.setAttribute("aria-hidden", "false");
}
