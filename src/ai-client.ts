import { CONFIG } from "./config";
import { state } from "./state";
import type { AiConfig, AiImageTaskType, AiInlineImagePayload } from "./types";
import {
  buildGoogleGenAiEndpoint,
  requestUserscriptJson,
  requestUserscriptSseStream,
} from "./userscript-http";
import { clamp, logDebug } from "./utils";

interface GoogleGenAiTextPart {
  text: string;
}

interface GoogleGenAiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

type GoogleGenAiPart = GoogleGenAiTextPart | GoogleGenAiInlineDataPart;

interface GoogleGenAiContent {
  role?: string;
  parts: GoogleGenAiPart[];
}

interface GoogleGenAiTool {
  googleSearch: Record<string, never>;
}

interface GoogleGenAiRequestBody {
  contents: GoogleGenAiContent[];
  generationConfig: {
    temperature: number;
  };
  systemInstruction?: GoogleGenAiContent;
  tools?: GoogleGenAiTool[];
}

interface GoogleGenAiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

const IMAGE_TASK_PROMPTS: Record<AiImageTaskType, string> = {
  explain: [
    "请用中文解释这张图片。",
    "请描述主体、场景、细节、风格与可能表达的意图。",
    "不确定的内容请明确标注“可能是…”。",
  ].join("\n"),
  translate: [
    "请识别这张图片里的文字并翻译成中文。",
    "请按“原文 -> 中文”逐条列出；无法识别的文字请写“[无法识别]”。",
    "如果图片里没有可读文字，请只回复“未检测到可翻译文字”。",
  ].join("\n"),
};

function sanitizeConfig(base: AiConfig): AiConfig {
  const safeBaseUrl = base.baseUrl.trim();
  const safeProvider = base.provider.trim();
  const safeModel = base.model.trim();
  const safeApiKey = base.apiKey.trim();
  const safeSystemPrompt = base.systemPrompt.trim();

  return {
    ...base,
    provider: safeProvider || CONFIG.defaultAiConfig.provider,
    baseUrl: safeBaseUrl || CONFIG.defaultAiConfig.baseUrl,
    apiKey: safeApiKey,
    model: safeModel || CONFIG.defaultAiConfig.model,
    systemPrompt: safeSystemPrompt,
    temperature: clamp(base.temperature, 0, 2),
  };
}

function resolveAiConfig(overrides?: Partial<AiConfig>): AiConfig {
  const merged: AiConfig = {
    ...CONFIG.defaultAiConfig,
    ...state.aiConfig,
    ...overrides,
  };

  return sanitizeConfig(merged);
}

function buildGoogleSearchGroundingTools(config: AiConfig): GoogleGenAiTool[] | undefined {
  if (!config.enableGoogleSearchGrounding) return undefined;

  return [
    {
      googleSearch: {},
    },
  ];
}

function buildImageTaskPrompt(taskType: AiImageTaskType, extraPrompt?: string): string {
  const basePrompt = IMAGE_TASK_PROMPTS[taskType];
  const safeExtraPrompt = extraPrompt?.trim();

  if (!safeExtraPrompt) {
    return basePrompt;
  }

  return `${basePrompt}\n\n补充要求：\n${safeExtraPrompt}`;
}

function sanitizeInlineImagePayload(payload: AiInlineImagePayload): AiInlineImagePayload {
  const mimeType = payload.mimeType.trim() || "image/jpeg";
  const base64Data = payload.base64Data.trim();

  if (!base64Data) {
    throw new Error("图片数据为空，无法发起 AI 请求。");
  }

  if (!/^image\//i.test(mimeType)) {
    throw new Error(`不支持的图片 MIME 类型：${mimeType}`);
  }

  return {
    mimeType,
    base64Data,
  };
}

function mergeStreamText(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (!previous) return incoming;
  if (incoming === previous) return previous;

  // 部分模型流式 chunk 返回累计文本，直接覆盖可避免重复拼接
  if (incoming.startsWith(previous)) {
    return incoming;
  }

  // 兜底：若是增量片段则追加
  if (previous.endsWith(incoming)) {
    return previous;
  }

  return `${previous}${incoming}`;
}

function buildGoogleGenAiRequestBody(
  contents: GoogleGenAiContent[],
  config: AiConfig,
): GoogleGenAiRequestBody {
  const tools = buildGoogleSearchGroundingTools(config);

  return {
    contents,
    generationConfig: {
      temperature: config.temperature,
    },
    ...(config.systemPrompt
      ? {
          systemInstruction: {
            parts: [
              {
                text: config.systemPrompt,
              },
            ],
          },
        }
      : {}),
    ...(tools ? { tools } : {}),
  };
}

export function buildGoogleGenAiRequest(
  contents: string,
  config: AiConfig,
): GoogleGenAiRequestBody {
  const prompt = contents.trim();
  if (!prompt) {
    throw new Error("Google GenAI 请求内容不能为空。");
  }

  return buildGoogleGenAiRequestBody(
    [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
    config,
  );
}

export function buildGoogleGenAiImageRequest(
  image: AiInlineImagePayload,
  taskType: AiImageTaskType,
  config: AiConfig,
  extraPrompt?: string,
): GoogleGenAiRequestBody {
  const safeImage = sanitizeInlineImagePayload(image);
  const prompt = buildImageTaskPrompt(taskType, extraPrompt);

  return buildGoogleGenAiRequestBody(
    [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
          {
            inlineData: {
              mimeType: safeImage.mimeType,
              data: safeImage.base64Data,
            },
          },
        ],
      },
    ],
    config,
  );
}

function ensureGoogleGenAiConfig(config: AiConfig): void {
  if (!config.apiKey) {
    throw new Error("Google GenAI API Key 为空，请先在 AI 设置中填写 API Key。");
  }
}

function extractGoogleGenAiText(response: GoogleGenAiResponse): string {
  const firstCandidate = response.candidates?.[0];
  const parts = firstCandidate?.content?.parts;
  if (!Array.isArray(parts) || parts.length <= 0) {
    return "";
  }

  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function extractGoogleGenAiErrorMessage(
  status: number,
  response: GoogleGenAiResponse | null,
): string {
  const serviceMessage = response?.error?.message?.trim();
  if (serviceMessage) {
    return serviceMessage;
  }

  if (status === 401 || status === 403) {
    return "Google GenAI 鉴权失败，请检查 API Key 是否有效且已开通对应模型权限。";
  }

  if (status === 429) {
    return "Google GenAI 请求过于频繁，请稍后重试。";
  }

  return `Google GenAI 请求失败（HTTP ${status}）。`;
}

async function executeGoogleGenAiRequest(
  requestBody: GoogleGenAiRequestBody,
  config: AiConfig,
  abortSignal?: AbortSignal,
): Promise<string> {
  ensureGoogleGenAiConfig(config);

  const url = buildGoogleGenAiEndpoint(config.baseUrl, config.model);

  try {
    const response = await requestUserscriptJson<GoogleGenAiResponse>({
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey,
      },
      data: JSON.stringify(requestBody),
      signal: abortSignal,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(extractGoogleGenAiErrorMessage(response.status, response.response ?? null));
    }

    return extractGoogleGenAiText(response.response ?? {});
  } catch (error) {
    logDebug("Google GenAI 请求失败：", error);
    throw error instanceof Error ? error : new Error("Google GenAI 请求失败。");
  }
}

interface ExecuteGoogleGenAiStreamRequestOptions {
  request: GoogleGenAiRequestBody;
  config: AiConfig;
  abortSignal?: AbortSignal;
  onChunk?: (aggregatedText: string, chunkText: string) => void;
}

interface GoogleGenAiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

function extractGoogleGenAiStreamChunkText(chunk: GoogleGenAiStreamChunk): string {
  const firstCandidate = chunk.candidates?.[0];
  const parts = firstCandidate?.content?.parts;
  if (!Array.isArray(parts) || parts.length <= 0) {
    return "";
  }

  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

async function executeGoogleGenAiStreamRequest(
  options: ExecuteGoogleGenAiStreamRequestOptions,
): Promise<string> {
  ensureGoogleGenAiConfig(options.config);

  const url = buildGoogleGenAiEndpoint(options.config.baseUrl, options.config.model, true);

  let aggregatedText = "";
  let lastError: Error | null = null;

  const handle = requestUserscriptSseStream(
    {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": options.config.apiKey,
      },
      data: JSON.stringify(options.request),
      signal: options.abortSignal,
    },
    (data) => {
      let chunk: GoogleGenAiStreamChunk;
      try {
        chunk = JSON.parse(data) as GoogleGenAiStreamChunk;
      } catch {
        return;
      }

      if (chunk.error) {
        const message = chunk.error.message?.trim() || "Google GenAI 流式请求返回错误。";
        lastError = new Error(message);
        handle.abort();
        return;
      }

      const chunkText = extractGoogleGenAiStreamChunkText(chunk);
      if (!chunkText) return;

      aggregatedText = mergeStreamText(aggregatedText, chunkText);
      options.onChunk?.(aggregatedText, chunkText);
    },
  );

  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      handle.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    options.abortSignal.addEventListener(
      "abort",
      () => {
        handle.abort();
      },
      { once: true },
    );
  }

  try {
    await handle.promise;
  } catch (error) {
    if (lastError) {
      throw lastError;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    logDebug("Google GenAI 流式请求失败：", error);
    throw error instanceof Error ? error : new Error("Google GenAI 流式请求失败。");
  }

  if (lastError) {
    logDebug("Google GenAI 流式请求返回错误：", lastError);
    throw lastError;
  }

  return aggregatedText.trim();
}

export async function generateWithGoogleGenAi(
  contents: string,
  overrides?: Partial<AiConfig>,
): Promise<string> {
  const resolvedConfig = resolveAiConfig(overrides);
  if (!resolvedConfig.enabled) {
    throw new Error("AI 功能未启用，请先在 AI 设置中开启。");
  }

  const request = buildGoogleGenAiRequest(contents, resolvedConfig);
  return executeGoogleGenAiRequest(request, resolvedConfig);
}

interface GenerateAiImageTaskOptions {
  image: AiInlineImagePayload;
  taskType: AiImageTaskType;
  extraPrompt?: string;
  overrides?: Partial<AiConfig>;
}

interface GenerateAiImageTaskStreamOptions extends GenerateAiImageTaskOptions {
  abortSignal?: AbortSignal;
  onChunk?: (aggregatedText: string, chunkText: string) => void;
}

export async function generateImageTaskWithConfiguredAi(
  options: GenerateAiImageTaskOptions,
): Promise<string> {
  const resolvedConfig = resolveAiConfig(options.overrides);
  if (!resolvedConfig.enabled) {
    throw new Error("AI 功能未启用，请先在 AI 设置中开启。");
  }

  if (resolvedConfig.apiFormat === "google-genai") {
    const request = buildGoogleGenAiImageRequest(
      options.image,
      options.taskType,
      resolvedConfig,
      options.extraPrompt,
    );

    return executeGoogleGenAiRequest(request, resolvedConfig);
  }

  throw new Error("当前仅实现了 google-genai API 格式，openai-compatible 适配待实现。");
}

export async function generateImageTaskStreamWithConfiguredAi(
  options: GenerateAiImageTaskStreamOptions,
): Promise<string> {
  const resolvedConfig = resolveAiConfig(options.overrides);
  if (!resolvedConfig.enabled) {
    throw new Error("AI 功能未启用，请先在 AI 设置中开启。");
  }

  if (resolvedConfig.apiFormat === "google-genai") {
    const request = buildGoogleGenAiImageRequest(
      options.image,
      options.taskType,
      resolvedConfig,
      options.extraPrompt,
    );

    return executeGoogleGenAiStreamRequest({
      request,
      config: resolvedConfig,
      abortSignal: options.abortSignal,
      onChunk: options.onChunk,
    });
  }

  throw new Error("当前仅实现了 google-genai API 格式，openai-compatible 适配待实现。");
}

export async function generateWithConfiguredAi(
  contents: string,
  overrides?: Partial<AiConfig>,
): Promise<string> {
  const resolvedConfig = resolveAiConfig(overrides);

  if (resolvedConfig.apiFormat === "google-genai") {
    return generateWithGoogleGenAi(contents, resolvedConfig);
  }

  throw new Error("当前仅实现了 google-genai API 格式，openai-compatible 适配待实现。");
}
