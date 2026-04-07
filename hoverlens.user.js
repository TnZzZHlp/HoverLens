// ==UserScript==
// @name         HoverLens - CtrlCtrl Image Preview
// @namespace    https://github.com/hoverlens/tampermonkey
// @version      1.0.0
// @description  悬停图片后双击 Ctrl 打开全屏预览，支持滚轮缩放、拖拽、双击重置与快捷关闭。
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /**
   * ---------------------------------------------------------------------------
   * Guard: 避免脚本重复初始化（SPA/重复注入场景）
   * ---------------------------------------------------------------------------
   */
  const INSTALL_GUARD_KEY = "__HOVERLENS_TM_INSTALLED__";
  if (window[INSTALL_GUARD_KEY]) return;
  window[INSTALL_GUARD_KEY] = true;

  // 如需在 iframe 内也生效，可删除此判断
  if (window.top !== window.self) return;

  /**
   * ---------------------------------------------------------------------------
   * Config: 集中配置（可按需调整）
   * ---------------------------------------------------------------------------
   */
  const CONFIG = {
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

  /**
   * ---------------------------------------------------------------------------
   * State: 统一状态管理
   * ---------------------------------------------------------------------------
   */
  const state = {
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

    activeImageUrl: "",
    lastCtrlKeydownAt: 0,

    globalEventsBound: false,
  };

  const refs = {
    overlay: null,
    image: null,
  };

  /**
   * ---------------------------------------------------------------------------
   * Utils
   * ---------------------------------------------------------------------------
   */
  function logDebug(...args) {
    if (CONFIG.debug) {
      console.debug("[HoverLens]", ...args);
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isElement(node) {
    return node instanceof Element;
  }

  function safeGetComputedStyle(el) {
    try {
      return window.getComputedStyle(el);
    } catch {
      return null;
    }
  }

  function resolveUrl(rawUrl) {
    if (typeof rawUrl !== "string") return null;
    const cleaned = rawUrl.trim().replace(/^['"]|['"]$/g, "");
    if (!cleaned) return null;
    if (/^javascript:/i.test(cleaned)) return null;

    if (/^data:image\//i.test(cleaned) || /^blob:/i.test(cleaned)) {
      return cleaned;
    }

    try {
      return new URL(cleaned, window.location.href).href;
    } catch {
      return null;
    }
  }

  function normalizeImageUrl(rawUrl, context) {
    const resolved = resolveUrl(rawUrl);
    if (!resolved) return null;

    if (typeof CONFIG.imageUrlResolverHook === "function") {
      try {
        const hooked = CONFIG.imageUrlResolverHook(resolved, context);
        return typeof hooked === "string" && hooked.trim() ? hooked.trim() : resolved;
      } catch (err) {
        logDebug("imageUrlResolverHook 执行失败，已回退默认 URL：", err);
      }
    }

    return resolved;
  }

  function pickBestFromSrcset(srcsetValue) {
    if (typeof srcsetValue !== "string" || !srcsetValue.trim()) return null;

    const entries = srcsetValue
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    let best = null;

    for (const entry of entries) {
      const tokens = entry.split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;

      let descriptor = "";
      let rawUrl = entry;

      const last = tokens[tokens.length - 1];
      if (/^\d+(\.\d+)?[wx]$/i.test(last)) {
        descriptor = last.toLowerCase();
        rawUrl = tokens.slice(0, -1).join(" ");
      } else {
        rawUrl = tokens.join(" ");
      }

      const url = resolveUrl(rawUrl);
      if (!url) continue;

      let score = 1;
      if (descriptor.endsWith("w")) {
        score = parseFloat(descriptor) || 1;
      } else if (descriptor.endsWith("x")) {
        score = (parseFloat(descriptor) || 1) * 1000;
      }

      if (!best || score > best.score) {
        best = { url, score };
      }
    }

    return best ? best.url : null;
  }

  function getBestImageUrlFromImg(img) {
    if (!isElement(img) || img.tagName !== "IMG") return null;

    // 1) currentSrc 最优先（浏览器已按 srcset/sizes 选择）
    if (img.currentSrc) {
      const url = normalizeImageUrl(img.currentSrc, { source: "img.currentSrc", element: img });
      if (url) return url;
    }

    // 2) srcset / data-srcset
    const srcsetCandidates = [
      img.getAttribute("srcset"),
      img.getAttribute("data-srcset"),
      img.getAttribute("data-lazy-srcset"),
    ];
    for (const srcset of srcsetCandidates) {
      const bestSrcsetUrl = pickBestFromSrcset(srcset);
      if (bestSrcsetUrl) {
        const url = normalizeImageUrl(bestSrcsetUrl, { source: "img.srcset", element: img });
        if (url) return url;
      }
    }

    // 3) 常见懒加载属性
    const attrCandidates = [
      "data-fullsrc",
      "data-original",
      "data-origin",
      "data-zoom-src",
      "data-large-image",
      "data-src",
      "data-lazy-src",
      "src",
    ];

    for (const attr of attrCandidates) {
      const raw = img.getAttribute(attr);
      if (!raw) continue;
      const url = normalizeImageUrl(raw, { source: `img.${attr}`, element: img });
      if (url) return url;
    }

    return null;
  }

  function extractBackgroundImageUrl(el) {
    if (!isElement(el)) return null;

    const style = safeGetComputedStyle(el);
    if (!style) return null;

    const bg = style.getPropertyValue("background-image") || style.backgroundImage;
    if (!bg || bg === "none") return null;

    const matches = [...bg.matchAll(/url\((['"]?)(.*?)\1\)/gi)];
    if (!matches.length) return null;

    for (const match of matches) {
      const rawUrl = match[2];
      const url = normalizeImageUrl(rawUrl, { source: "background-image", element: el });
      if (url) return url;
    }

    return null;
  }

  function findDescendantImage(container) {
    if (!isElement(container)) return null;

    // 优先直系子节点中的 img（更接近“最近”语义）
    try {
      const directChildImg = container.querySelector(":scope > img");
      if (directChildImg) return directChildImg;
    } catch {
      // :scope 兼容性问题时回退
    }

    return container.querySelector("img");
  }

  /**
   * 图片识别规则（优先级）：
   * 1) 悬停元素本身是 img
   * 2) 悬停元素或其近层祖先内部最近的 img
   * 3) 悬停元素或其祖先上的 background-image
   */
  function getImageUrlFromElement(startElement) {
    if (!isElement(startElement)) return null;
    if (refs.overlay && refs.overlay.contains(startElement)) return null;

    let node = startElement;
    let depth = 0;

    while (isElement(node) && depth <= CONFIG.maxAncestorSearchDepth) {
      // 1) 当前元素本身是 <img>
      if (node.tagName === "IMG") {
        const selfImgUrl = getBestImageUrlFromImg(node);
        if (selfImgUrl) return selfImgUrl;
      }

      // 2) 当前元素（或较近祖先）内部最近 <img>
      if (depth <= CONFIG.descendantSearchDepth) {
        const descendantImg = findDescendantImage(node);
        if (descendantImg) {
          const descendantImgUrl = getBestImageUrlFromImg(descendantImg);
          if (descendantImgUrl) return descendantImgUrl;
        }
      }

      // 3) background-image（当前元素及祖先）
      const bgUrl = extractBackgroundImageUrl(node);
      if (bgUrl) return bgUrl;

      if (node === document.body) break;
      node = node.parentElement;
      depth += 1;
    }

    return null;
  }

  function isEditableTarget(target) {
    if (!isElement(target)) return false;

    // 原生可编辑区域
    const nativeEditableSelector = [
      "input",
      "textarea",
      "select",
      '[contenteditable]:not([contenteditable="false"])',
      '[role="textbox"]',
      '[role="searchbox"]',
    ].join(",");

    if (target.matches(nativeEditableSelector) || target.closest(nativeEditableSelector)) {
      return true;
    }

    if (target.isContentEditable) {
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

  function shouldIgnoreHotkey(event) {
    // 避免与系统/浏览器快捷键组合产生误触
    if (event.altKey || event.metaKey) return true;

    const activeEl = document.activeElement;
    if (isEditableTarget(event.target) || isEditableTarget(activeEl)) {
      return true;
    }

    return false;
  }

  function detectDoubleCtrl(event) {
    if (!event || event.key !== "Control") return false;
    if (event.repeat) return false; // 长按防抖

    const now = performance.now();
    const isDouble =
      state.lastCtrlKeydownAt > 0 && now - state.lastCtrlKeydownAt <= CONFIG.doubleCtrlInterval;

    state.lastCtrlKeydownAt = now;
    return isDouble;
  }

  /**
   * ---------------------------------------------------------------------------
   * Overlay / UI
   * ---------------------------------------------------------------------------
   */
  function ensureStyle() {
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

  function createOverlay() {
    ensureStyle();

    let overlay = document.getElementById(CONFIG.overlayId);
    let image = overlay ? overlay.querySelector(".hl-tm-preview-image") : null;

    if (!overlay || !image) {
      overlay = document.createElement("div");
      overlay.id = CONFIG.overlayId;
      overlay.setAttribute("aria-hidden", "true");

      image = document.createElement("img");
      image.className = "hl-tm-preview-image";
      image.alt = "Image Preview";

      overlay.appendChild(image);
    }

    if (!overlay.isConnected) {
      (document.documentElement || document.body).appendChild(overlay);
    }

    refs.overlay = overlay;
    refs.image = image;

    if (!overlay.dataset.bound) {
      overlay.dataset.bound = "1";

      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          closePreview();
        }
      });

      overlay.addEventListener("wheel", handleWheelZoom, { passive: false });

      image.addEventListener("mousedown", handleDragStart);
      image.addEventListener("dblclick", (event) => {
        event.preventDefault();
        resetTransform();
        applyTransform();
      });
      image.addEventListener("dragstart", (event) => event.preventDefault());
    }

    return overlay;
  }

  function applyTransform() {
    if (!refs.image) return;
    refs.image.style.transform = `translate3d(${state.translateX}px, ${state.translateY}px, 0) scale(${state.scale})`;
  }

  function resetTransform() {
    state.scale = 1;
    state.translateX = 0;
    state.translateY = 0;
    state.dragging = false;

    if (refs.overlay) refs.overlay.classList.remove("is-dragging");
    if (refs.image) refs.image.style.cursor = "grab";
  }

  function openPreview(imageUrl) {
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

    applyTransform();
  }

  function closePreview() {
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

  /**
   * ---------------------------------------------------------------------------
   * Interactions
   * ---------------------------------------------------------------------------
   */
  function handleWheelZoom(event) {
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

  function handleDragStart(event) {
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

  function handleDragMove(event) {
    if (!state.dragging || !state.isOpen) return;

    event.preventDefault();

    const dx = event.clientX - state.dragStartX;
    const dy = event.clientY - state.dragStartY;

    state.translateX = state.startTranslateX + dx;
    state.translateY = state.startTranslateY + dy;

    applyTransform();
  }

  function handleDragEnd() {
    if (!state.dragging) return;

    state.dragging = false;
    if (refs.overlay) refs.overlay.classList.remove("is-dragging");
    if (refs.image) refs.image.style.cursor = "grab";
  }

  /**
   * ---------------------------------------------------------------------------
   * Hover Tracking & Keyboard
   * ---------------------------------------------------------------------------
   */
  function getReliableHoverElementFromEvent(event) {
    if (!event) return null;

    if (typeof event.composedPath === "function") {
      const path = event.composedPath();
      for (const node of path) {
        if (isElement(node)) return node;
      }
    }

    return isElement(event.target) ? event.target : null;
  }

  function updateHoveredElement(event) {
    const target = getReliableHoverElementFromEvent(event);
    if (!target) return;

    if (refs.overlay && refs.overlay.contains(target)) return;

    state.hoveredElement = target;

    if (typeof event.clientX === "number") state.pointerX = event.clientX;
    if (typeof event.clientY === "number") state.pointerY = event.clientY;
  }

  function handleKeydown(event) {
    if (!event) return;

    // Esc: 无条件优先关闭预览
    if (event.key === "Escape") {
      state.lastCtrlKeydownAt = 0;
      if (state.isOpen) {
        event.preventDefault();
        closePreview();
      }
      return;
    }

    // 非 Ctrl 键：重置双击计时，防止 Ctrl + 其他键误触
    if (event.key !== "Control") {
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
    if (
      !isElement(candidate) &&
      Number.isFinite(state.pointerX) &&
      Number.isFinite(state.pointerY)
    ) {
      candidate = document.elementFromPoint(state.pointerX, state.pointerY);
    }

    const imageUrl = getImageUrlFromElement(candidate);
    if (!imageUrl) {
      logDebug("未找到可预览图片，已忽略本次触发。", candidate);
      return;
    }

    openPreview(imageUrl);
  }

  function bindGlobalEvents() {
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

  function bootstrap() {
    bindGlobalEvents();
    createOverlay(); // 提前创建单例，避免首次触发时延迟
    logDebug("初始化完成");
  }

  bootstrap();
})();
