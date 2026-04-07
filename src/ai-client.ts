import {
  GoogleGenAI,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type Tool,
} from "@google/genai";
import { CONFIG } from "./config";
import { state } from "./state";
import type { AiConfig, AiImageTaskType, AiInlineImagePayload } from "./types";
import { clamp, logDebug } from "./utils";

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

function buildGoogleSearchGroundingTools(config: AiConfig): Tool[] | undefined {
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

export function buildGoogleGenAiRequest(
  contents: string,
  config: AiConfig,
): GenerateContentParameters {
  const prompt = contents.trim();
  if (!prompt) {
    throw new Error("Google GenAI 请求内容不能为空。");
  }

  const tools = buildGoogleSearchGroundingTools(config);
  const requestConfig: GenerateContentConfig = {
    temperature: config.temperature,
    ...(config.systemPrompt ? { systemInstruction: config.systemPrompt } : {}),
    ...(tools ? { tools } : {}),
  };

  return {
    model: config.model,
    contents: prompt,
    config: requestConfig,
  };
}

export function buildGoogleGenAiImageRequest(
  image: AiInlineImagePayload,
  taskType: AiImageTaskType,
  config: AiConfig,
  extraPrompt?: string,
  abortSignal?: AbortSignal,
): GenerateContentParameters {
  const safeImage = sanitizeInlineImagePayload(image);
  const prompt = buildImageTaskPrompt(taskType, extraPrompt);

  const tools = buildGoogleSearchGroundingTools(config);
  const requestConfig: GenerateContentConfig = {
    temperature: config.temperature,
    ...(abortSignal ? { abortSignal } : {}),
    ...(config.systemPrompt ? { systemInstruction: config.systemPrompt } : {}),
    ...(tools ? { tools } : {}),
  };

  return {
    model: config.model,
    contents: [
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
    config: requestConfig,
  };
}

function createGoogleGenAiClient(config: AiConfig): GoogleGenAI {
  if (!config.apiKey) {
    throw new Error("Google GenAI API Key 为空，请先在 AI 设置中填写 API Key。");
  }

  const httpOptions = config.baseUrl
    ? {
        baseUrl: config.baseUrl,
      }
    : undefined;

  return new GoogleGenAI({
    apiKey: config.apiKey,
    ...(httpOptions ? { httpOptions } : {}),
  });
}

async function executeGoogleGenAiRequest(
  request: GenerateContentParameters,
  config: AiConfig,
): Promise<string> {
  const client = createGoogleGenAiClient(config);

  try {
    const response = await client.models.generateContent(request);
    return response.text?.trim() ?? "";
  } catch (error) {
    logDebug("Google GenAI 请求失败：", error);
    throw error instanceof Error ? error : new Error("Google GenAI 请求失败。");
  }
}

interface ExecuteGoogleGenAiStreamRequestOptions {
  request: GenerateContentParameters;
  config: AiConfig;
  onChunk?: (aggregatedText: string, chunkText: string) => void;
}

async function executeGoogleGenAiStreamRequest(
  options: ExecuteGoogleGenAiStreamRequestOptions,
): Promise<string> {
  const client = createGoogleGenAiClient(options.config);

  try {
    const stream = await client.models.generateContentStream(options.request);
    let aggregatedText = "";

    for await (const chunk of stream) {
      const chunkText = chunk.text ?? "";
      if (!chunkText) continue;

      aggregatedText = mergeStreamText(aggregatedText, chunkText);
      options.onChunk?.(aggregatedText, chunkText);
    }

    return aggregatedText.trim();
  } catch (error) {
    logDebug("Google GenAI 流式请求失败：", error);
    throw error instanceof Error ? error : new Error("Google GenAI 流式请求失败。");
  }
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
      options.abortSignal,
    );

    return executeGoogleGenAiStreamRequest({
      request,
      config: resolvedConfig,
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
