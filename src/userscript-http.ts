import { GM_xmlhttpRequest } from "$";
import type { AiInlineImagePayload } from "./types";

interface UserscriptRequestOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: BodyInit | null;
  responseType?: "text" | "json" | "arraybuffer" | "blob" | "stream";
  timeout?: number;
  anonymous?: boolean;
  signal?: AbortSignal;
}

interface UserscriptResponse<TResponse> {
  status: number;
  statusText: string;
  responseHeaders: string;
  responseText: string;
  response: TResponse;
  finalUrl: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function normalizeHttpStatus(status: number): number {
  return Number.isFinite(status) ? status : 0;
}

function normalizeMimeType(rawValue: string | null): string | null {
  if (!rawValue) return null;

  const mimeType = rawValue.split(";")[0]?.trim().toLowerCase() ?? "";
  return mimeType || null;
}

function getResponseHeader(responseHeaders: string, headerName: string): string | null {
  const targetName = headerName.trim().toLowerCase();
  if (!targetName) return null;

  for (const line of responseHeaders.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;

    const currentName = line.slice(0, separatorIndex).trim().toLowerCase();
    if (currentName !== targetName) continue;

    const value = line.slice(separatorIndex + 1).trim();
    return value || null;
  }

  return null;
}

function inferMimeTypeFromUrl(imageUrl: string): string {
  const cleanUrl = imageUrl.split("?")[0].split("#")[0].toLowerCase();

  if (cleanUrl.endsWith(".png")) return "image/png";
  if (cleanUrl.endsWith(".webp")) return "image/webp";
  if (cleanUrl.endsWith(".gif")) return "image/gif";
  if (cleanUrl.endsWith(".bmp")) return "image/bmp";
  if (cleanUrl.endsWith(".svg")) return "image/svg+xml";
  if (cleanUrl.endsWith(".jpg") || cleanUrl.endsWith(".jpeg")) return "image/jpeg";

  return "image/jpeg";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (!bytes.length) return "";

  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

function textToBase64(value: string): string {
  return arrayBufferToBase64(new TextEncoder().encode(value).buffer);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("图片编码失败。"));
        return;
      }

      const commaIndex = reader.result.indexOf(",");
      const base64Data = commaIndex >= 0 ? reader.result.slice(commaIndex + 1).trim() : "";
      if (!base64Data) {
        reject(new Error("图片编码失败，未获取到有效数据。"));
        return;
      }

      resolve(base64Data);
    };

    reader.onerror = () => {
      reject(new Error("图片编码失败。"));
    };

    reader.readAsDataURL(blob);
  });
}

function decodeDataUrlImage(imageUrl: string): AiInlineImagePayload | null {
  if (!/^data:/i.test(imageUrl)) {
    return null;
  }

  const commaIndex = imageUrl.indexOf(",");
  if (commaIndex < 0) {
    throw new Error("图片数据格式无效，无法解析。");
  }

  const metadata = imageUrl.slice(5, commaIndex);
  const dataPart = imageUrl.slice(commaIndex + 1);
  const metadataParts = metadata
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const mimeType = normalizeMimeType(metadataParts[0] ?? null) ?? "text/plain";

  if (!/^image\//i.test(mimeType)) {
    throw new Error("当前资源不是有效图片格式，暂不支持解释/翻译。");
  }

  const isBase64 = metadataParts.some((item) => item.toLowerCase() === "base64");
  const base64Data = isBase64
    ? dataPart.replace(/\s+/g, "")
    : textToBase64(
        (() => {
          try {
            return decodeURIComponent(dataPart);
          } catch {
            return dataPart;
          }
        })(),
      );

  if (!base64Data) {
    throw new Error("图片编码失败，未获取到有效数据。");
  }

  return {
    mimeType,
    base64Data,
  };
}

function blobToInlineImagePayload(
  blob: Blob,
  fallbackMimeType: string,
): Promise<AiInlineImagePayload> {
  const mimeType = normalizeMimeType(blob.type) ?? fallbackMimeType;
  if (!/^image\//i.test(mimeType)) {
    throw new Error("当前资源不是有效图片格式，暂不支持解释/翻译。");
  }

  return blobToBase64(blob).then((base64Data) => ({
    mimeType,
    base64Data,
  }));
}

function requestLocalBlob(imageUrl: string, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbortSignal);
    };

    const rejectWithAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    const handleAbortSignal = () => {
      try {
        xhr.abort();
      } catch {
        rejectWithAbort();
      }
    };

    xhr.open("GET", imageUrl, true);
    xhr.responseType = "blob";

    xhr.onload = () => {
      cleanup();

      if (!(xhr.response instanceof Blob) || xhr.response.size <= 0) {
        reject(new Error("图片数据为空，无法解析。"));
        return;
      }

      const status = normalizeHttpStatus(xhr.status);
      if (status !== 0 && (status < 200 || status >= 300)) {
        reject(new Error(`图片加载失败（HTTP ${status}）。`));
        return;
      }

      resolve(xhr.response);
    };

    xhr.onerror = () => {
      cleanup();
      reject(new Error("无法读取本地 blob 图片内容。"));
    };

    xhr.onabort = () => {
      rejectWithAbort();
    };

    if (signal) {
      if (signal.aborted) {
        handleAbortSignal();
        return;
      }

      signal.addEventListener("abort", handleAbortSignal, { once: true });
    }

    xhr.send();
  });
}

function userscriptRequest<TResponse>(
  options: UserscriptRequestOptions,
): Promise<UserscriptResponse<TResponse>> {
  if (typeof GM_xmlhttpRequest !== "function") {
    throw new Error(
      "当前脚本环境不支持 GM_xmlhttpRequest。请确认已在用户脚本管理器中安装并授予权限。",
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      options.signal?.removeEventListener("abort", handleAbortSignal);
    };

    const settleResolve = (value: UserscriptResponse<TResponse>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const request = GM_xmlhttpRequest({
      method: options.method ?? "GET",
      url: options.url,
      headers: options.headers,
      data: options.data ?? undefined,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      anonymous: options.anonymous ?? true,
      responseType: options.responseType ?? "text",
      onload: (event) => {
        settleResolve({
          status: normalizeHttpStatus(event.status),
          statusText: event.statusText,
          responseHeaders: event.responseHeaders,
          responseText: event.responseText,
          response: event.response as TResponse,
          finalUrl: event.finalUrl,
        });
      },
      onerror: (event) => {
        const status = normalizeHttpStatus(event.status);
        const message = status
          ? `请求失败（HTTP ${status} ${event.statusText || ""}）。`.trim()
          : "请求失败，可能未被用户脚本管理器授权访问该域名。";
        settleReject(new Error(message));
      },
      ontimeout: () => {
        settleReject(new Error("请求超时，请稍后重试。"));
      },
      onabort: () => {
        settleReject(createAbortError());
      },
    });

    const handleAbortSignal = () => {
      try {
        request.abort();
      } catch {
        settleReject(createAbortError());
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        handleAbortSignal();
        return;
      }

      options.signal.addEventListener("abort", handleAbortSignal, { once: true });
    }
  });
}

function ensureSuccessStatus(status: number, fallbackMessage: string): void {
  if (status >= 200 && status < 300) {
    return;
  }

  throw new Error(`${fallbackMessage}（HTTP ${status || 0}）。`);
}

export function buildGoogleGenAiEndpoint(baseUrl: string, model: string, stream?: boolean): string {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const versionedBaseUrl = /\/v\d+(alpha|beta)?$/i.test(trimmedBaseUrl)
    ? trimmedBaseUrl
    : `${trimmedBaseUrl}/v1beta`;
  const normalizedModel = model.trim().startsWith("models/")
    ? model.trim()
    : `models/${model.trim()}`;
  const encodedModel = normalizedModel
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const method = stream ? "streamGenerateContent" : "generateContent";
  const query = stream ? "?alt=sse" : "";

  return `${versionedBaseUrl}/${encodedModel}:${method}${query}`;
}

function buildHttpErrorMessage(status: number, statusText?: string): string {
  const normalizedStatus = normalizeHttpStatus(status);
  return normalizedStatus
    ? `请求失败（HTTP ${normalizedStatus} ${statusText || ""}）。`.trim()
    : "请求失败，可能未被用户脚本管理器授权访问该域名。";
}

interface UserscriptSseCallbacks {
  onEvent?: (event: string, data: string) => void;
  onData?: (data: string) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

interface UserscriptSseHandle {
  abort: () => void;
  promise: Promise<void>;
}

interface SseTextParser {
  pushText: (text: string) => void;
  flush: () => void;
}

function createSseTextParser(callbacks: UserscriptSseCallbacks): SseTextParser {
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const emitEvent = () => {
    if (dataLines.length <= 0) {
      eventName = "message";
      return;
    }

    const eventData = dataLines.join("\n");
    callbacks.onEvent?.(eventName, eventData);
    callbacks.onData?.(eventData);

    eventName = "message";
    dataLines = [];
  };

  const consumeLine = (line: string) => {
    const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!normalizedLine) {
      emitEvent();
      return;
    }

    if (normalizedLine.startsWith(":")) {
      return;
    }

    const separatorIndex = normalizedLine.indexOf(":");
    const field = separatorIndex >= 0 ? normalizedLine.slice(0, separatorIndex) : normalizedLine;
    let value = separatorIndex >= 0 ? normalizedLine.slice(separatorIndex + 1) : "";

    // SSE 规范：冒号后首个空格需忽略
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      eventName = value || "message";
      return;
    }

    if (field === "data") {
      dataLines.push(value);
    }
  };

  const processBuffer = (flushRemainder = false) => {
    while (true) {
      const lineEndIndex = buffer.indexOf("\n");
      if (lineEndIndex < 0) {
        break;
      }

      const line = buffer.slice(0, lineEndIndex);
      buffer = buffer.slice(lineEndIndex + 1);
      consumeLine(line);
    }

    if (flushRemainder) {
      if (buffer) {
        consumeLine(buffer);
        buffer = "";
      }

      emitEvent();
    }
  };

  return {
    pushText: (text: string) => {
      if (!text) return;
      buffer += text;
      processBuffer(false);
    },
    flush: () => {
      processBuffer(true);
    },
  };
}

function asReadableUint8Stream(value: unknown): ReadableStream<Uint8Array> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const stream = value as ReadableStream<Uint8Array>;
  if (typeof stream.getReader !== "function") {
    return null;
  }

  return stream;
}

function requestUserscriptSse(
  options: UserscriptRequestOptions,
  callbacks: UserscriptSseCallbacks,
): UserscriptSseHandle {
  if (typeof GM_xmlhttpRequest !== "function") {
    const error = new Error(
      "当前脚本环境不支持 GM_xmlhttpRequest。请确认已在用户脚本管理器中安装并授予权限。",
    );
    callbacks.onError?.(error);
    return {
      abort: () => {},
      promise: Promise.reject(error),
    };
  }

  let settled = false;
  let aborted = false;
  let usingReadableStream = false;
  let lastResponseText = "";
  let gmRequest: ReturnType<typeof GM_xmlhttpRequest> | null = null;
  let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  let resolvePromise: (() => void) | null = null;
  let rejectPromise: ((error: Error) => void) | null = null;

  const cleanup = () => {
    if (options.signal) {
      options.signal.removeEventListener("abort", handleAbortSignal);
    }
  };

  const settleResolve = () => {
    if (settled) return;
    settled = true;
    cleanup();
    callbacks.onComplete?.();
    resolvePromise?.();
  };

  const settleReject = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    callbacks.onError?.(error);
    rejectPromise?.(error);
  };

  const finalizeSuccess = (responseText?: string) => {
    if (aborted || settled) {
      return;
    }

    appendResponseText(responseText);
    parser.flush();
    settleResolve();
    stopTransport();
  };

  const stopTransport = () => {
    if (streamReader) {
      void streamReader.cancel().catch(() => {
        // ignore
      });
    }

    if (gmRequest) {
      try {
        gmRequest.abort();
      } catch {
        // ignore
      }
    }
  };

  const finishByDoneSignal = () => {
    if (aborted || settled) return;

    finalizeSuccess();
  };

  const parser = createSseTextParser({
    onEvent: (event, data) => {
      callbacks.onEvent?.(event, data);
    },
    onData: (data) => {
      if (data.trim() === "[DONE]") {
        finishByDoneSignal();
        return;
      }

      callbacks.onData?.(data);
    },
  });

  const handleAbortSignal = () => {
    if (aborted) return;

    aborted = true;

    stopTransport();

    settleReject(createAbortError());
  };

  const appendResponseText = (responseText?: string) => {
    if (aborted || settled) return;

    const nextResponseText = responseText ?? "";
    if (!nextResponseText) {
      return;
    }

    const newText = nextResponseText.startsWith(lastResponseText)
      ? nextResponseText.slice(lastResponseText.length)
      : nextResponseText;

    lastResponseText = nextResponseText;
    if (!newText) {
      return;
    }

    parser.pushText(newText);
  };

  const consumeReadableStream = (stream: ReadableStream<Uint8Array>) => {
    if (aborted || settled) {
      return;
    }

    usingReadableStream = true;
    streamReader = stream.getReader();
    const textDecoder = new TextDecoder();

    void (async () => {
      try {
        while (!aborted && !settled) {
          const { done, value } = await streamReader.read();
          if (aborted || settled) {
            return;
          }

          if (done) {
            break;
          }

          if (value && value.byteLength > 0) {
            const chunkText = textDecoder.decode(value, { stream: true });
            if (chunkText) {
              if (aborted || settled) {
                return;
              }

              parser.pushText(chunkText);
            }
          }
        }

        if (aborted || settled) {
          return;
        }

        const tailText = textDecoder.decode();
        if (tailText) {
          parser.pushText(tailText);
        }

        finalizeSuccess();
      } catch (error) {
        if (aborted || settled) {
          return;
        }

        const streamError = error instanceof Error ? error : new Error("读取流式响应失败。");
        settleReject(streamError);
      } finally {
        try {
          streamReader?.releaseLock();
        } catch {
          // ignore
        }

        streamReader = null;
      }
    })();
  };

  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = (error: Error) => {
      reject(error);
    };

    gmRequest = GM_xmlhttpRequest({
      method: options.method ?? "POST",
      url: options.url,
      headers: options.headers,
      data: options.data ?? undefined,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      anonymous: options.anonymous ?? false,
      responseType: "stream",
      onloadstart: (event) => {
        if (aborted || settled || usingReadableStream) {
          return;
        }

        const stream = asReadableUint8Stream(event.response);
        if (!stream) {
          return;
        }

        consumeReadableStream(stream);
      },
      onload: (event) => {
        if (aborted || settled) {
          return;
        }

        const status = normalizeHttpStatus(event.status);
        if (status && (status < 200 || status >= 300)) {
          settleReject(new Error(buildHttpErrorMessage(status, event.statusText)));
          return;
        }

        finalizeSuccess(event.responseText);
      },
      onloadend: () => {
        if (aborted || settled) {
          return;
        }

        // 兜底：部分环境可能未按预期触发 stream reader done 或 onload 完整结算。
        finalizeSuccess();
      },
      onerror: (event) => {
        if (aborted || settled) {
          return;
        }

        settleReject(new Error(buildHttpErrorMessage(event.status, event.statusText)));
      },
      ontimeout: () => {
        if (aborted || settled) {
          return;
        }

        settleReject(new Error("请求超时，请稍后重试。"));
      },
      onabort: () => {
        if (settled) {
          return;
        }

        handleAbortSignal();
      },
      onprogress: (event) => {
        if (aborted || settled || usingReadableStream) {
          return;
        }

        appendResponseText(event.responseText);
      },
    });

    if (options.signal) {
      if (options.signal.aborted) {
        handleAbortSignal();
        return;
      }

      options.signal.addEventListener("abort", handleAbortSignal, { once: true });
    }
  });

  return {
    abort: handleAbortSignal,
    promise,
  };
}

export async function requestUserscriptJson<TResponse>(
  options: UserscriptRequestOptions,
): Promise<UserscriptResponse<TResponse>> {
  return userscriptRequest<TResponse>({
    ...options,
    responseType: "json",
  });
}

export function requestUserscriptSseStream(
  options: UserscriptRequestOptions,
  onData: (data: string) => void,
): UserscriptSseHandle {
  return requestUserscriptSse(options, {
    onData,
  });
}

export async function fetchInlineImagePayloadViaUserscript(
  imageUrl: string,
  signal?: AbortSignal,
): Promise<AiInlineImagePayload> {
  const dataUrlPayload = decodeDataUrlImage(imageUrl);
  if (dataUrlPayload) {
    return dataUrlPayload;
  }

  if (/^blob:/i.test(imageUrl)) {
    const blob = await requestLocalBlob(imageUrl, signal);
    return blobToInlineImagePayload(blob, inferMimeTypeFromUrl(imageUrl));
  }

  let response: UserscriptResponse<ArrayBuffer>;

  try {
    response = await userscriptRequest<ArrayBuffer>({
      method: "GET",
      url: imageUrl,
      responseType: "arraybuffer",
      headers: {
        Accept: "image/*,*/*;q=0.8",
      },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    throw new Error("无法读取图片内容，可能未授权访问该图片域名。请确认脚本已允许跨域连接后重试。");
  }

  ensureSuccessStatus(response.status, "图片加载失败");

  const imageBuffer = response.response;
  if (!(imageBuffer instanceof ArrayBuffer) || imageBuffer.byteLength <= 0) {
    throw new Error("图片数据为空，无法解析。");
  }

  const contentTypeHeader = normalizeMimeType(
    getResponseHeader(response.responseHeaders, "content-type"),
  );
  const mimeType =
    contentTypeHeader && contentTypeHeader !== "application/octet-stream"
      ? contentTypeHeader
      : inferMimeTypeFromUrl(response.finalUrl || imageUrl);

  if (!/^image\//i.test(mimeType)) {
    throw new Error("当前资源不是有效图片格式，暂不支持解释/翻译。");
  }

  const base64Data = arrayBufferToBase64(imageBuffer);
  if (!base64Data) {
    throw new Error("图片编码失败，未获取到有效数据。");
  }

  return {
    mimeType,
    base64Data,
  };
}
