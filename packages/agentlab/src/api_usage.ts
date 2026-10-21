import { randomUUID } from 'node:crypto';
import type { AgentLabEndpoint, AgentLabUsage } from './types';
import {
  isUnsupportedTemperature,
  readParameterRejection,
  withoutTemperature,
} from './temperature_fallback';

export class ApiHttpError extends Error {
  constructor(
    path: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`接口 ${path} 返回 HTTP ${status}${detail ? `：${detail}` : ''}`);
  }
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 不估算缺失的分项；仅两个分项都已知时才可求和。 */
export function parseApiUsage(
  raw: unknown,
): Pick<AgentLabUsage, 'promptTokens' | 'completionTokens' | 'totalTokens'> {
  const candidate = raw && typeof raw === 'object' && 'usage' in raw ? raw.usage : null;
  const usage = candidate && typeof candidate === 'object' ? candidate : {};
  const promptTokens =
    count('prompt_tokens' in usage ? usage.prompt_tokens : undefined) ??
    count('input_tokens' in usage ? usage.input_tokens : undefined);
  const completionTokens =
    count('completion_tokens' in usage ? usage.completion_tokens : undefined) ??
    count('output_tokens' in usage ? usage.output_tokens : undefined);
  const total = count('total_tokens' in usage ? usage.total_tokens : undefined);
  const sum =
    promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null;
  return { promptTokens, completionTokens, totalTokens: total ?? count(sum) };
}

export function isApiCancellation(error: unknown, signal?: AbortSignal | null): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return false;
  if (signal?.reason instanceof Error && signal.reason.name === 'TimeoutError') return false;
  return Boolean(signal?.aborted || (error instanceof Error && error.name === 'AbortError'));
}

/** OpenAI 兼容接口可能以 HTTP 200／SSE 数据帧返回业务错误。 */
export function apiErrorMessage(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || !('error' in raw) || !raw.error) return null;
  const error = raw.error;
  if (typeof error === 'string') return error.slice(0, 300);
  if (typeof error === 'object')
    return 'message' in error && typeof error.message === 'string' && error.message.trim()
      ? error.message.slice(0, 300)
      : '模型服务返回错误';
  return null;
}

/** 一次实际 HTTP 尝试一个 ID；流式用量更新与结束回执均更新同一条账目。 */
export function beginApiUsage(endpoint: AgentLabEndpoint, stream = false) {
  const record: AgentLabUsage = {
    requestId: randomUUID(),
    startedAt: Date.now(),
    status: 'pending',
    model: endpoint.model,
    kind: endpoint.kind ?? 'chat',
    feature: endpoint.feature,
    stream,
    source: endpoint.source ?? 'api',
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
  };
  const emit = () => {
    if (record.source === 'local') return;
    // 记账故障不能改变已发生的请求结果，尤其不能诱导重发。
    try {
      endpoint.onUsage?.({ ...record });
    } catch {}
  };
  emit();
  return {
    report(raw: unknown) {
      const next = parseApiUsage(raw);
      record.promptTokens = next.promptTokens ?? record.promptTokens;
      record.completionTokens = next.completionTokens ?? record.completionTokens;
      record.totalTokens = next.totalTokens ?? record.totalTokens;
      emit();
    },
    finish(status: Exclude<NonNullable<AgentLabUsage['status']>, 'pending'>) {
      if (record.status !== 'pending') return;
      record.status = status;
      emit();
    },
  };
}

export async function fetchApi(
  endpoint: AgentLabEndpoint,
  path: string,
  init: RequestInit,
  stream = false,
): Promise<{
  response: Response;
  usage: ReturnType<typeof beginApiUsage>;
  temperatureOmitted: boolean;
}> {
  init.signal?.throwIfAborted();
  const usage = beginApiUsage(endpoint, stream);
  try {
    const response = await fetch(`${endpoint.baseUrl}${path}`, init);
    const mayRejectParameter = [400, 422].includes(response.status);
    const fallback = mayRejectParameter ? withoutTemperature(path, init) : null;
    if (fallback) {
      const rejection = await readParameterRejection(response);
      init.signal?.throwIfAborted();
      if (isUnsupportedTemperature(rejection, response.status)) {
        usage.report(rejection);
        usage.finish('failed');
        await response.body?.cancel().catch(() => {});
        const retry = await fetchApi(endpoint, path, fallback, stream);
        return { ...retry, temperatureOmitted: true };
      }
    }
    return { response, usage, temperatureOmitted: false };
  } catch (error) {
    usage.finish(isApiCancellation(error, init.signal) ? 'cancelled' : 'failed');
    throw error;
  }
}

export async function requestApiJson<T>(
  endpoint: AgentLabEndpoint,
  path: string,
  init: RequestInit,
): Promise<T> {
  const { response, usage, temperatureOmitted } = await fetchApi(endpoint, path, init);
  try {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const detail = text.trim().slice(0, 300);
      try {
        usage.report(JSON.parse(text));
      } catch {}
      throw new ApiHttpError(path, response.status, detail);
    }
    const data: unknown = await response.json();
    usage.report(data);
    const temperatureRejected = isUnsupportedTemperature(data, response.status);
    const error =
      apiErrorMessage(data) ?? (temperatureRejected ? apiErrorMessage({ error: data }) : null);
    if (error || temperatureRejected) {
      const fallback = temperatureOmitted ? null : withoutTemperature(path, init);
      if (fallback && temperatureRejected) {
        usage.finish('failed');
        return await requestApiJson<T>(endpoint, path, fallback);
      }
      throw new Error(`模型服务错误：${error ?? '模型不支持温度参数'}`);
    }
    usage.finish('success');
    return data as T;
  } catch (error) {
    usage.finish(isApiCancellation(error, init.signal) ? 'cancelled' : 'failed');
    throw error;
  }
}
