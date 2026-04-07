import { CONFIG } from "./config";
import { refs } from "./state";
import { isElement, normalizeImageUrl, pickBestFromSrcset, safeGetComputedStyle } from "./utils";

function getBestImageUrlFromImg(img: HTMLImageElement): string | null {
  // 1) currentSrc 最优先（浏览器已按 srcset/sizes 选择）
  if (img.currentSrc) {
    const currentSrcUrl = normalizeImageUrl(img.currentSrc, {
      source: "img.currentSrc",
      element: img,
    });
    if (currentSrcUrl) return currentSrcUrl;
  }

  // 2) srcset / data-srcset
  const srcsetCandidates = [
    img.getAttribute("srcset"),
    img.getAttribute("data-srcset"),
    img.getAttribute("data-lazy-srcset"),
  ];

  for (const srcset of srcsetCandidates) {
    const bestSrcsetUrl = pickBestFromSrcset(srcset);
    if (!bestSrcsetUrl) continue;

    const srcsetUrl = normalizeImageUrl(bestSrcsetUrl, {
      source: "img.srcset",
      element: img,
    });
    if (srcsetUrl) return srcsetUrl;
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

    const imageUrl = normalizeImageUrl(raw, {
      source: `img.${attr}`,
      element: img,
    });
    if (imageUrl) return imageUrl;
  }

  return null;
}

function extractBackgroundImageUrl(el: Element): string | null {
  const style = safeGetComputedStyle(el);
  if (!style) return null;

  const bg = style.getPropertyValue("background-image") || style.backgroundImage;
  if (!bg || bg === "none") return null;

  const matches = [...bg.matchAll(/url\((['"]?)(.*?)\1\)/gi)];
  if (!matches.length) return null;

  for (const match of matches) {
    const rawUrl = match[2];
    const bgUrl = normalizeImageUrl(rawUrl, {
      source: "background-image",
      element: el,
    });
    if (bgUrl) return bgUrl;
  }

  return null;
}

function findDescendantImage(container: Element): HTMLImageElement | null {
  // 优先直系子节点中的 img（更接近“最近”语义）
  try {
    const directChildImg = container.querySelector(":scope > img");
    if (directChildImg instanceof HTMLImageElement) return directChildImg;
  } catch {
    // :scope 兼容性问题时回退
  }

  const fallback = container.querySelector("img");
  return fallback instanceof HTMLImageElement ? fallback : null;
}

/**
 * 图片识别规则（优先级）：
 * 1) 悬停元素本身是 img
 * 2) 悬停元素或其近层祖先内部最近的 img
 * 3) 悬停元素或其祖先上的 background-image
 */
export function getImageUrlFromElement(startElement: Element | null): string | null {
  if (!isElement(startElement)) return null;
  if (refs.overlay && refs.overlay.contains(startElement)) return null;

  let node: Element | null = startElement;
  let depth = 0;

  while (node && depth <= CONFIG.maxAncestorSearchDepth) {
    // 1) 当前元素本身是 <img>
    if (node instanceof HTMLImageElement) {
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
