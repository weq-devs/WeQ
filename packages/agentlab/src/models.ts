import type { AgentLabModelCapability, AgentLabProviderModel } from './types';
import { mergeModelDetails, modelFromMetadata, record } from './model_metadata';

function trimSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}

/**
 * 把用户填的 base_url 变成模型列表端点：已经带 /models 的地址原样返回。
 */
export function resolveModelsEndpoint(baseUrl: string): string {
  const base = trimSlash(baseUrl.trim());
  if (!base) return '';
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

/**
 * 旧调用方的名称启发式；模型发现与配置不再使用此结果。
 */
export function inferCapabilities(id: string): AgentLabModelCapability[] {
  const lower = id.toLowerCase();
  if (/embed/.test(lower)) return ['embedding'];
  const caps: AgentLabModelCapability[] = ['chat'];
  if (/(^|[^a-z])(vl|vision|omni|4o|4\.1|4v)([^a-z]|$)/.test(lower)) caps.push('vision');
  return caps;
}

/**
 * 从模型列表响应里抽出条目，兼容 OpenAI 风格 / {models:[]} / 裸数组三种形状。
 */
export function parseModelList(data: unknown, source?: string): AgentLabProviderModel[] {
  let raw: unknown[] = [];
  if (Array.isArray(data)) raw = data;
  else if (data && typeof data === 'object') {
    const holder = record(data);
    if (Array.isArray(holder.data)) raw = holder.data;
    else if (Array.isArray(holder.models)) raw = holder.models;
    else if (Array.isArray(record(holder.output).models))
      raw = record(holder.output).models as unknown[];
  }

  const seen = new Set<string>();
  const models: AgentLabProviderModel[] = [];
  for (const item of raw) {
    const model = modelFromMetadata(record(item), source);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

/**
 * 仅读取实际配置服务的目录及已识别原生详情，不发送推理请求。
 * 未知服务保留兼容扩展字段，不根据端口或模型名称选择另一家服务。
 */
export async function fetchProviderModels(input: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  vendor?: string;
  modelIds?: string[];
}): Promise<AgentLabProviderModel[]> {
  let url = resolveModelsEndpoint(input.baseUrl);
  if (!url) throw new Error('Base URL 不能为空');

  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = input.apiKey?.trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const nativeBase = trimSlash(input.baseUrl.trim()).replace(/\/v1$/i, '');
  if (input.vendor === 'ollama') url = `${nativeBase}/api/tags`;
  if (input.vendor === 'lmstudio') url = `${nativeBase}/api/v1/models`;
  if (input.vendor === 'omlx') url = `${nativeBase}/v1/models/status`;
  if (input.vendor === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (apiKey) headers['x-api-key'] = apiKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  try {
    const request = async (target: string, body?: unknown): Promise<unknown> => {
      const res = await fetch(target, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => ''))
          .trim()
          .replaceAll(apiKey || '\0', '[已隐藏]')
          .slice(0, 300);
        throw new Error(`模型元数据 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
      }
      return res.json();
    };
    const models: AgentLabProviderModel[] = [];
    let metadataError: string | undefined;
    const cursors = new Set<string>();
    let next = url;
    for (let page = 0; next && page < 100; page++) {
      let data: unknown;
      try {
        data = await request(next);
      } catch (error) {
        if (
          page !== 0 ||
          !['ollama', 'lmstudio', 'omlx'].includes(input.vendor ?? '') ||
          controller.signal.aborted
        )
          throw error;
        metadataError = error instanceof Error ? error.message : String(error);
        url = resolveModelsEndpoint(input.baseUrl);
        next = url;
        data = await request(next);
      }
      const list = parseModelList(data, next);
      models.push(...list);
      const holder = record(data);
      next = '';
      if (holder.has_more === true) {
        const cursor = holder.last_id;
        if (typeof cursor !== 'string' || cursors.has(cursor))
          throw new Error('模型目录分页游标缺失或重复');
        cursors.add(cursor);
        const pageUrl = new URL(url);
        pageUrl.searchParams.set('after_id', cursor);
        next = pageUrl.href;
      } else if (typeof holder.nextPageToken === 'string' && holder.nextPageToken) {
        if (cursors.has(holder.nextPageToken)) throw new Error('模型目录分页游标重复');
        cursors.add(holder.nextPageToken);
        const pageUrl = new URL(url);
        pageUrl.searchParams.set('pageToken', holder.nextPageToken);
        next = pageUrl.href;
      }
      if (page === 99 && next) throw new Error('模型目录超过 100 页，请缩小查询范围');
    }
    const unique = [...new Map(models.map((model) => [model.id, model])).values()];
    if (metadataError) for (const model of unique) model.metadata!.error = metadataError;
    // 硅基流动的类型筛选声明用途；同模板下的自定义网关不能套用此契约。
    if (input.vendor === 'siliconflow' && new URL(url).hostname === 'api.siliconflow.cn') {
      const groups = await Promise.all(
        (['chat', 'embedding'] as const).map(async (capability) => {
          const target = new URL(url);
          target.searchParams.set('sub_type', capability);
          try {
            return {
              capability,
              ids: new Set(parseModelList(await request(target.href)).map((model) => model.id)),
            };
          } catch (error) {
            return { capability, error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      for (const model of unique) {
        for (const group of groups) {
          if (group.ids && model.metadata!.capabilities[group.capability] === 'unknown')
            model.metadata!.capabilities[group.capability] = group.ids.has(model.id)
              ? 'supported'
              : 'unsupported';
          if (group.error) model.metadata!.error = group.error;
        }
        model.capabilities = (['chat', 'embedding', 'vision'] as const).filter(
          (key) => model.metadata!.capabilities[key] === 'supported',
        );
      }
    }
    if (!input.modelIds) return unique;
    const selected: AgentLabProviderModel[] = [];
    for (const id of input.modelIds) {
      let model = unique.find((item) => item.id === id) ?? modelFromMetadata({ id }, url)!;
      if (
        input.vendor === 'ollama' ||
        ((Object.values(model.metadata!.capabilities).includes('unknown') ||
          (model.metadata!.reasoning.supported !== false &&
            model.metadata!.reasoning.controls.length === 0)) &&
          ['openai', 'anthropic', 'gemini', 'mistral'].includes(input.vendor ?? ''))
      ) {
        try {
          const target =
            input.vendor === 'ollama'
              ? `${nativeBase}/api/show`
              : `${resolveModelsEndpoint(input.baseUrl)}/${encodeURIComponent(id)}`;
          const detail = await request(
            target,
            input.vendor === 'ollama' ? { model: id } : undefined,
          );
          model = modelFromMetadata(
            { ...mergeModelDetails(model.metadata!.raw, record(detail)), id },
            target,
          )!;
        } catch (error) {
          model.metadata!.error = error instanceof Error ? error.message : String(error);
        }
      }
      selected.push(model);
    }
    return selected;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('请求超时，请检查网络或 Base URL');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
