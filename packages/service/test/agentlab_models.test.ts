/**
 * AgentLab「按 base_url 拉取模型列表」的单测（参考 MaiBot 的 /models 代理）：
 * 端点拼接、各种响应形状解析、能力猜测、以及 fetch 失败时的错误信息。
 * 这些函数是设置页「拉取可用模型」的第一道防线，值得钉死。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchProviderModels,
  inferCapabilities,
  parseModelList,
  resolveModelsEndpoint,
} from '@weq/agentlab';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveModelsEndpoint', () => {
  it('给 host 补 /models，并去掉尾斜杠', () => {
    expect(resolveModelsEndpoint('https://api.siliconflow.cn/v1')).toBe(
      'https://api.siliconflow.cn/v1/models',
    );
    expect(resolveModelsEndpoint('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/models',
    );
  });

  it('已经带 /models 的地址不重复拼接', () => {
    expect(resolveModelsEndpoint('https://api.x.com/v1/models')).toBe(
      'https://api.x.com/v1/models',
    );
    expect(resolveModelsEndpoint('https://api.x.com/v1/models/')).toBe(
      'https://api.x.com/v1/models',
    );
  });

  it('空串返回空串', () => {
    expect(resolveModelsEndpoint('   ')).toBe('');
  });
});

describe('inferCapabilities', () => {
  it('embedding 模型只给向量能力', () => {
    expect(inferCapabilities('text-embedding-3-small')).toEqual(['embedding']);
    expect(inferCapabilities('bge-m3-embed')).toEqual(['embedding']);
  });

  it('视觉命名特征额外带 vision', () => {
    expect(inferCapabilities('Qwen/Qwen3-VL-30B-A3B-Instruct')).toEqual(['chat', 'vision']);
    expect(inferCapabilities('gpt-4o')).toEqual(['chat', 'vision']);
    expect(inferCapabilities('glm-4v-flash')).toEqual(['chat', 'vision']);
    expect(inferCapabilities('moonshot-v1-8k-vision-preview')).toEqual(['chat', 'vision']);
  });

  it('普通聊天模型只有 chat', () => {
    expect(inferCapabilities('deepseek-chat')).toEqual(['chat']);
    expect(inferCapabilities('qwen-plus')).toEqual(['chat']);
  });

  it('纯 embed 即使带 vision 也算向量', () => {
    expect(inferCapabilities('image-embedding-vision')).toEqual(['embedding']);
  });
});

describe('parseModelList', () => {
  it('解析 OpenAI 风格 { data: [{ id }] }', () => {
    const models = parseModelList({
      data: [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'deepseek-chat' }],
    });
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'deepseek-chat']);
    expect(models[0]?.label).toBe('GPT-4o');
    expect(models[0]?.capabilities).toEqual(['chat', 'vision']);
  });

  it('解析 { models: [...] } 与裸数组', () => {
    expect(parseModelList({ models: [{ id: 'a' }] }).map((m) => m.id)).toEqual(['a']);
    expect(parseModelList([{ model: 'b' }]).map((m) => m.id)).toEqual(['b']);
  });

  it('去重、跳过空 id / 非对象，name === id 时不重复当 label', () => {
    const models = parseModelList({
      data: [{ id: 'a' }, { id: 'a' }, { id: '  ' }, null, 'x', { id: 'c', name: 'c' }],
    });
    expect(models.map((m) => m.id)).toEqual(['a', 'c']);
    expect(models[0]?.label).toBeUndefined();
    expect(models[1]?.label).toBeUndefined();
  });

  it('无法识别的形状返回空数组', () => {
    expect(parseModelList({ foo: 1 })).toEqual([]);
    expect(parseModelList('nope')).toEqual([]);
  });
});

describe('fetchProviderModels', () => {
  it('拼 /models 并用 Bearer 鉴权，解析返回的模型', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchProviderModels({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(models.map((m) => m.id)).toEqual(['gpt-4o-mini', 'text-embedding-3-small']);
  });

  it('apiKey 为空时不带鉴权头（本地 Ollama 之类）', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchProviderModels({ baseUrl: 'http://localhost:11434/v1' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('HTTP 非 2xx 时抛出带状态码与响应体的错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":"invalid api key"}',
      })),
    );
    await expect(
      fetchProviderModels({ baseUrl: 'https://api.x.com/v1', apiKey: 'bad' }),
    ).rejects.toThrow(/HTTP 401.*invalid api key/);
  });

  it('空 Base URL 直接报错，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModels({ baseUrl: '  ' })).rejects.toThrow('Base URL 不能为空');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
