import { CONFIG } from "./config";
import type { ImageUrlContext } from "./types";

export function logDebug(...args: unknown[]): void {
  if (CONFIG.debug) {
    console.debug("[HoverLens]", ...args);
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isElement(node: unknown): node is Element {
  return node instanceof Element;
}

export function safeGetComputedStyle(el: Element): CSSStyleDeclaration | null {
  try {
    return window.getComputedStyle(el);
  } catch {
    return null;
  }
}

export function resolveUrl(rawUrl: string | null | undefined): string | null {
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

export function normalizeImageUrl(
  rawUrl: string | null | undefined,
  context: ImageUrlContext,
): string | null {
  const resolved = resolveUrl(rawUrl);
  if (!resolved) return null;

  if (typeof CONFIG.imageUrlResolverHook === "function") {
    try {
      const hooked = CONFIG.imageUrlResolverHook(resolved, context);
      return typeof hooked === "string" && hooked.trim() ? hooked.trim() : resolved;
    } catch (error) {
      logDebug("imageUrlResolverHook 执行失败，已回退默认 URL：", error);
    }
  }

  return resolved;
}

export function pickBestFromSrcset(srcsetValue: string | null | undefined): string | null {
  if (typeof srcsetValue !== "string" || !srcsetValue.trim()) return null;

  const entries = srcsetValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  let best: { url: string; score: number } | null = null;

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
      score = Number.parseFloat(descriptor) || 1;
    } else if (descriptor.endsWith("x")) {
      score = (Number.parseFloat(descriptor) || 1) * 1000;
    }

    if (!best || score > best.score) {
      best = { url, score };
    }
  }

  return best ? best.url : null;
}
