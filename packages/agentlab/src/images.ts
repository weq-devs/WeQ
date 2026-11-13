import type { AgentLabEndpoint } from './types';
import { requestApiJson } from './api_usage';
import { pickMessageText } from './http';

export const AI_IMAGE_DEFAULTS = {
  assistant: 'vision',
  cloneChat: 'vision',
  cloneTraining: 'placeholder',
  intent: 'placeholder',
  suggestions: 'placeholder',
  profile: 'placeholder',
} as const;
export type AiImageFeature = keyof typeof AI_IMAGE_DEFAULTS;
export type AiImageMode = 'placeholder' | 'ocr' | 'vision';
export type AiImagePreferences = Record<AiImageFeature, AiImageMode>;
export interface AiImageRef {
  id: string;
  name?: string;
  path?: string;
  url?: string;
  file?: string;
  chat?: { kind: 'c2c' | 'group'; conv: string; msgId: string; index: number };
  market?: { pack: string; hash: string };
  media?: {
    fileName: string;
    fileToken: string;
    width: number;
    height: number;
    sendTime: number;
    md5?: string;
    originalUrl?: string;
    emoji?: boolean;
  };
}
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
export interface AiImageOutcome {
  id: string;
  mode: AiImageMode;
  status: 'read' | 'skipped' | 'failed' | 'direct';
  text?: string;
  notes: string[];
}
export interface AiPreparedInput {
  images?: AiImageRef[];
  text: string;
  content: string | AiContentPart[];
  outcomes: AiImageOutcome[];
}
export interface AiImageProgress {
  imageId?: string;
  stage: 'queued' | 'load' | 'cache' | 'vision' | 'ocr' | 'fallback' | 'complete';
  text: string;
  outcome?: AiImageOutcome;
}
export interface AiImagePort {
  prepare(input: {
    feature: AiImageFeature;
    personaId?: string;
    text: string;
    images?: AiImageRef[];
    endpoint?: AgentLabEndpoint;
    direct?: boolean;
    signal?: AbortSignal;
    forceOcr?: boolean;
    question?: string;
    onProgress?(progress: AiImageProgress): void;
  }): Promise<AiPreparedInput>;
  revision?(feature?: AiImageFeature): string;
}
export function normalizeImagePreferences(value: unknown): AiImagePreferences {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.entries(AI_IMAGE_DEFAULTS).map(([key, fallback]) => {
      const mode = raw[key];
      const valid =
        mode === 'ocr' ||
        mode === 'vision' ||
        (mode === 'placeholder' && key !== 'assistant' && key !== 'cloneChat');
      return [key, valid ? mode : fallback];
    }),
  ) as AiImagePreferences;
}

export async function visionImageCompletion(
  endpoint: AgentLabEndpoint,
  text: string,
  images: string[],
  system = '结合用户问题理解图片，如实描述可见内容与文字。无法确定的细节明确说明，不编造。',
): Promise<string> {
  const data = await requestApiJson<{
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  }>(
    { ...endpoint, kind: 'vision', feature: endpoint.feature ?? 'image-analysis' },
    '/chat/completions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text },
              ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          },
        ],
      }),
      signal: endpoint.signal,
    },
  );
  const result = pickMessageText(data.choices?.[0]?.message).trim();
  if (!result) throw new Error('视觉模型未返回图片解读');
  return result;
}

export interface AiImageProcessorDeps {
  mode(feature: AiImageFeature): AiImageMode;
  vision(input: { feature: AiImageFeature; personaId?: string }): AgentLabEndpoint | null;
  load(image: AiImageRef, signal?: AbortSignal): Promise<{ dataUrl: string; key: string }>;
  ocr(
    image: AiImageRef,
    signal?: AbortSignal,
  ): Promise<{ text: string; skipped?: boolean; notes?: string[] }>;
  cached?(key: string): Promise<string | null>;
  cache?(key: string, text: string): Promise<void>;
  revision?(feature?: AiImageFeature): string;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export class AiImageProcessor implements AiImagePort {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly descriptions = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly signalKeys = new WeakMap<AbortSignal, number>();
  private nextSignal = 0;
  constructor(private readonly deps: AiImageProcessorDeps) {}
  revision(feature?: AiImageFeature) {
    return this.deps.revision?.(feature) ?? '';
  }
  async prepare(input: Parameters<AiImagePort['prepare']>[0]): Promise<AiPreparedInput> {
    input.signal?.throwIfAborted();
    if (this.active >= 4) {
      input.onProgress?.({ stage: 'queued', text: '等待图片处理空位' });
      await new Promise<void>((resolve, reject) => {
        const release = () => {
          input.signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          const index = this.waiting.indexOf(release);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(input.signal?.reason ?? new DOMException('已取消', 'AbortError'));
        };
        this.waiting.push(release);
        input.signal?.addEventListener('abort', abort, { once: true });
      });
    } else this.active++;
    try {
      return await this.run(input);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
  private async run(input: Parameters<AiImagePort['prepare']>[0]): Promise<AiPreparedInput> {
    const images = (input.images ?? []).map((image) => ({ ...image }));
    const outcomes: AiImageOutcome[] = [];
    const parts: AiContentPart[] = [{ type: 'text', text: input.text }];
    const annotations: string[] = [];
    const mode = input.forceOcr ? 'ocr' : this.deps.mode(input.feature);
    for (const image of images) {
      input.signal?.throwIfAborted();
      const outcome: AiImageOutcome = { id: image.id, mode, status: 'skipped', notes: [] };
      outcomes.push(outcome);
      const report = (stage: AiImageProgress['stage'], text: string) =>
        input.onProgress?.({ imageId: image.id, stage, text });
      const complete = () =>
        input.onProgress?.({
          imageId: image.id,
          stage: 'complete',
          text:
            outcome.status === 'failed'
              ? '图片读取失败，保留图片占位'
              : outcome.status === 'direct'
                ? '图片已准备好，将随主请求发送'
                : mode === 'placeholder'
                  ? '按设置保留图片占位，不读取图片'
                  : outcome.status === 'skipped'
                    ? '筛图未检测到文字，保留图片占位'
                    : `${outcome.mode === 'ocr' ? 'OCR 识别' : '视觉分析'}完成，得到 ${outcome.text?.length ?? 0} 字`,
          outcome,
        });
      if (mode === 'placeholder') {
        annotations.push('[图片]');
        complete();
        continue;
      }
      if (mode === 'vision') {
        let visionKey = '';
        try {
          const endpoint = this.deps.vision(input);
          if (!endpoint) throw new Error('未配置默认视觉模型');
          visionKey = endpoint.apiKey;
          report('load', '正在读取图片（必要时下载）');
          const loaded = await this.deps.load(image, input.signal);
          input.signal?.throwIfAborted();
          const same =
            input.endpoint &&
            endpoint.model === input.endpoint.model &&
            endpoint.baseUrl.replace(/\/+$/, '') === input.endpoint.baseUrl.replace(/\/+$/, '') &&
            endpoint.apiKey === input.endpoint.apiKey;
          if (same && input.direct) {
            parts.push(
              { type: 'text', text: `[图片 ${image.id}]` },
              { type: 'image_url', image_url: { url: loaded.dataUrl } },
            );
            outcome.status = 'direct';
            complete();
            continue;
          }
          // 通用描述不含用户问题，问题相关答案不得污染内容缓存。
          const key = JSON.stringify([
            loaded.key,
            endpoint.modelIdentity ?? endpoint.model,
            endpoint.baseUrl,
          ]);
          report('cache', '正在检查图片解读缓存');
          let description = input.question
            ? null
            : (this.descriptions.get(key) ?? (await this.deps.cached?.(key).catch(() => null)));
          if (!description) {
            let signalKey = 0;
            if (input.signal) {
              signalKey = this.signalKeys.get(input.signal) ?? ++this.nextSignal;
              this.signalKeys.set(input.signal, signalKey);
            }
            const requestKey = JSON.stringify([key, signalKey, input.question]);
            let pending = this.inFlight.get(requestKey);
            report(
              'vision',
              `${pending ? '正在等待同图分析' : '正在请求视觉模型'} ${endpoint.model} 返回`,
            );
            if (!pending) {
              pending = visionImageCompletion(
                { ...endpoint, signal: input.signal, feature: `${input.feature}-image` },
                input.question ||
                  '描述这张图片的可见内容、布局及图中文字；保留图表数据和截图中的关键信息。',
                [loaded.dataUrl],
              );
              this.inFlight.set(requestKey, pending);
            }
            try {
              description = await pending;
            } finally {
              if (this.inFlight.get(requestKey) === pending) this.inFlight.delete(requestKey);
            }
            input.signal?.throwIfAborted();
            if (!input.question) {
              if (this.descriptions.size >= 256)
                this.descriptions.delete(this.descriptions.keys().next().value!);
              this.descriptions.set(key, description);
              await this.deps.cache?.(key, description).catch(() => undefined);
            }
          } else report('cache', '已命中图片解读缓存，无需请求视觉模型');
          outcome.status = 'read';
          outcome.text = description;
          annotations.push(`[图片 ${image.id} · 视觉解读]\n${description}`);
          complete();
          continue;
        } catch (error) {
          input.signal?.throwIfAborted();
          if (error instanceof Error && error.name === 'AbortError') throw error;
          const reason = errorText(error);
          outcome.notes.push(
            `视觉未成功，回退 OCR：${visionKey ? reason.split(visionKey).join('[已隐藏]') : reason}`,
          );
          report('fallback', outcome.notes.at(-1)!);
        }
      }
      try {
        report('ocr', '正在进行 OCR 文字识别（含取图、缓存检查与筛图）');
        const result = await this.deps.ocr(image, input.signal);
        input.signal?.throwIfAborted();
        outcome.mode = 'ocr';
        outcome.status = result.skipped ? 'skipped' : 'read';
        outcome.text = result.text;
        outcome.notes.push(...(result.notes ?? []));
        annotations.push(
          `[图片 ${image.id} · ${result.skipped ? '筛图未检测到文字' : 'OCR'}]\n${result.text || '未识别到文字；不代表图片没有其他内容。'}`,
        );
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        outcome.status = 'failed';
        outcome.notes.push(errorText(error));
        annotations.push(`[图片 ${image.id} · 未能读取：${errorText(error)}]`);
      }
      complete();
    }
    const text = [input.text, ...annotations].filter(Boolean).join('\n');
    parts[0] = { type: 'text', text };
    return { text, content: parts.length > 1 ? parts : text, outcomes, images };
  }
}
