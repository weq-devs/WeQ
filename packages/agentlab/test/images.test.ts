import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiImageProcessor,
  normalizeImagePreferences,
  type AiImageProcessorDeps,
  type AiImageProgress,
} from '../src/images';

const endpoint = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'vision' };
const image = { id: 'one', path: '/fixture/image.png' };
function fixture(mode: 'placeholder' | 'ocr' | 'vision' = 'vision') {
  const deps = {
    mode: () => mode,
    vision: vi.fn<AiImageProcessorDeps['vision']>(() => endpoint),
    load: vi.fn<AiImageProcessorDeps['load']>(async () => ({
      dataUrl: 'data:image/png;base64,fixture',
      key: 'image-content',
    })),
    ocr: vi.fn<AiImageProcessorDeps['ocr']>(async () => ({
      text: 'OCR 文字',
      notes: [] as string[],
    })),
    cached: vi.fn(async (): Promise<string | null> => null),
    cache: vi.fn(async () => {}),
  } satisfies AiImageProcessorDeps;
  return { deps, processor: new AiImageProcessor(deps) };
}
afterEach(() => vi.unstubAllGlobals());

describe('共用 AI 图片处理', () => {
  it('训练图片将视觉增量接入调用方输出，缓存命中不伪造输出', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response('data: {"choices":[{"delta":{"content":"合成画面"}}]}\n\ndata: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const f = fixture();
    const onOutput = vi.fn();
    const input = { feature: 'cloneTraining' as const, text: '', images: [image], onOutput };
    const result = await f.processor.prepare(input);
    expect(result.outcomes[0]?.text).toBe('合成画面');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'cloneTraining-image',
        channel: 'content',
        text: '合成画面',
      }),
    );
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).stream).toBe(true);
    onOutput.mockClear();
    await f.processor.prepare(input);
    expect(fetch).toHaveBeenCalledOnce();
    expect(onOutput).not.toHaveBeenCalled();
  });
  it('视觉阶段按真实取图、缓存、模型等待及完成上报，缓存命中不冒充模型请求', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return new Response(JSON.stringify({ choices: [{ message: { content: '合成画面' } }] }));
      }),
    );
    const f = fixture();
    const events: AiImageProgress[] = [];
    const onProgress = (progress: AiImageProgress) => {
      events.push(progress);
    };
    const input = { feature: 'suggestions' as const, text: '', images: [image], onProgress };
    const pending = f.processor.prepare(input);
    try {
      await vi.waitFor(() =>
        expect(events.map((event) => event.stage)).toEqual(['load', 'cache', 'vision']),
      );
      expect(events.at(-1)?.text).toContain(endpoint.model);
    } finally {
      release();
      await pending;
    }
    expect(events.at(-1)).toMatchObject({
      stage: 'complete',
      outcome: { status: 'read', mode: 'vision' },
    });
    events.length = 0;
    await f.processor.prepare(input);
    expect(events.map((event) => event.stage)).toEqual(['load', 'cache', 'cache', 'complete']);
    expect(events.some((event) => event.text.includes('命中'))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('base64');
  });
  it('视觉失败的进度先说明回退再进入 OCR，失败与筛图跳过分别记录', async () => {
    const f = fixture();
    f.deps.vision.mockReturnValue(null);
    f.deps.ocr.mockRejectedValueOnce(new Error('合成 OCR 失败'));
    const events: AiImageProgress[] = [];
    await f.processor.prepare({
      feature: 'suggestions',
      text: '',
      images: [image],
      onProgress: (progress) => {
        events.push(progress);
      },
    });
    expect(events.map((event) => event.stage)).toEqual(['fallback', 'ocr', 'complete']);
    expect(events[0]?.text).toContain('未配置默认视觉模型');
    expect(events.at(-1)).toMatchObject({ outcome: { status: 'failed' } });
    f.deps.ocr.mockResolvedValueOnce({ text: '', skipped: true });
    events.length = 0;
    await f.processor.prepare({
      feature: 'suggestions',
      text: '',
      images: [image],
      onProgress: (progress) => {
        events.push(progress);
      },
    });
    expect(events.at(-1)).toMatchObject({ outcome: { status: 'skipped', mode: 'ocr' } });
  });
  it('图片并发已满时上报排队，取消排队不报告完成', async () => {
    const f = fixture('ocr');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.deps.ocr.mockImplementation(async () => {
      await gate;
      return { text: '合成文字', notes: [] };
    });
    const input = { feature: 'suggestions' as const, text: '', images: [image] };
    const active = Array.from({ length: 4 }, () => f.processor.prepare(input));
    const events: AiImageProgress[] = [];
    const controller = new AbortController();
    const queued = f.processor.prepare({
      ...input,
      signal: controller.signal,
      onProgress: (progress) => {
        events.push(progress);
      },
    });
    try {
      expect(events.map((event) => event.stage)).toEqual(['queued']);
      controller.abort();
      await expect(queued).rejects.toThrow();
      expect(events.map((event) => event.stage)).toEqual(['queued']);
    } finally {
      release();
      await Promise.all(active);
    }
  });
  it('各功能缺省值与不允许占位的功能一致，未知值不变成新能力', () => {
    expect(
      normalizeImagePreferences({ assistant: 'placeholder', cloneChat: 'bad', profile: 'ocr' }),
    ).toMatchObject({
      assistant: 'vision',
      cloneChat: 'vision',
      cloneTraining: 'placeholder',
      profile: 'ocr',
    });
  });
  it('文字占位不取图，不调用 OCR 或视觉', async () => {
    const f = fixture('placeholder');
    expect(
      await f.processor.prepare({ feature: 'intent', text: '原文', images: [image] }),
    ).toMatchObject({ text: '原文\n[图片]' });
    expect(f.deps.load).not.toHaveBeenCalled();
    expect(f.deps.ocr).not.toHaveBeenCalled();
    expect(f.deps.vision).not.toHaveBeenCalled();
  });
  it('OCR 不升级到视觉，失败后保留原消息及图片定位', async () => {
    const f = fixture('ocr');
    f.deps.ocr.mockRejectedValueOnce(new Error('模型未就绪'));
    const result = await f.processor.prepare({
      feature: 'assistant',
      text: '原文',
      images: [image],
    });
    expect(result.text).toContain('原文');
    expect(result.text).toContain('未能读取');
    expect(result.outcomes[0]).toMatchObject({ id: 'one', status: 'failed' });
    expect(f.deps.vision).not.toHaveBeenCalled();
  });
  it('视觉失败回退 OCR，多图按输入顺序保留', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unsupported', { status: 400 })),
    );
    const f = fixture();
    const result = await f.processor.prepare({
      feature: 'assistant',
      text: '问题',
      images: [image, { ...image, id: 'two' }],
    });
    expect(result.outcomes.map((item) => item.id)).toEqual(['one', 'two']);
    expect(result.outcomes.every((item) => item.mode === 'ocr')).toBe(true);
    expect(f.deps.ocr).toHaveBeenCalledTimes(2);
  });
  it('提供方在错误中回显密钥时，不将它写进图片处理记录', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`invalid key ${endpoint.apiKey}`, { status: 401 })),
    );
    const f = fixture();
    const result = await f.processor.prepare({ feature: 'assistant', text: '', images: [image] });
    expect(JSON.stringify(result.outcomes)).not.toContain(endpoint.apiKey);
    expect(result.outcomes[0]?.mode).toBe('ocr');
  });
  it('同端点同模型可直接传图，不重复调用视觉；强制回退仅做 OCR', async () => {
    const f = fixture();
    const input = {
      feature: 'assistant' as const,
      text: '问题',
      images: [image],
      endpoint,
      direct: true,
    };
    const prepared = await f.processor.prepare(input);
    expect(prepared.content).toEqual([
      { type: 'text', text: '问题' },
      { type: 'text', text: '[图片 one]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } },
    ]);
    expect(f.deps.ocr).not.toHaveBeenCalled();
    expect((await f.processor.prepare({ ...input, forceOcr: true })).text).toContain('OCR 文字');
  });
  it('问题相关回答不读取或写入通用描述缓存', async () => {
    const fetch = vi.fn(
      async (_input: unknown, _options?: RequestInit) =>
        new Response(JSON.stringify({ choices: [{ message: { content: '图中数字为 7' } }] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const f = fixture();
    await f.processor.prepare({
      feature: 'assistant',
      text: '',
      question: '数字是什么',
      images: [image],
    });
    expect(f.deps.cached).not.toHaveBeenCalled();
    expect(f.deps.cache).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).messages[1].content[0].text).toBe(
      '数字是什么',
    );
  });
  it('取消视觉请求不触发 OCR', async () => {
    const f = fixture();
    const ac = new AbortController();
    f.deps.load.mockImplementationOnce(async () => {
      ac.abort();
      throw new DOMException('取消', 'AbortError');
    });
    await expect(
      f.processor.prepare({ feature: 'assistant', text: '', images: [image], signal: ac.signal }),
    ).rejects.toThrow();
    expect(f.deps.ocr).not.toHaveBeenCalled();
  });
  it('无文字筛图与未识别出文字不冒充看懂画面', async () => {
    const f = fixture('ocr');
    f.deps.ocr.mockResolvedValueOnce({
      text: '',
      notes: ['筛图未检测到文字'],
      skipped: true,
    } as Awaited<ReturnType<AiImageProcessorDeps['ocr']>>);
    const result = await f.processor.prepare({ feature: 'assistant', text: '', images: [image] });
    expect(result.text).toContain('不代表图片没有其他内容');
    expect(result.outcomes[0]?.status).toBe('skipped');
  });
  it('持久化的只读图片引用不被下载器改写，新素材引用单独返回', async () => {
    const f = fixture();
    f.deps.load.mockImplementationOnce(async (ref) => {
      ref.path = '/new/cached.png';
      return { dataUrl: 'data:image/png;base64,fixture', key: 'image-content' };
    });
    const original = Object.freeze({ ...image });
    const result = await f.processor.prepare({
      feature: 'cloneChat',
      text: '',
      images: [original],
      endpoint,
      direct: true,
    });
    expect(original.path).toBe('/fixture/image.png');
    expect(result.images?.[0]?.path).toBe('/new/cached.png');
  });
  it('并发的同图通用解读合并请求，后续命中缓存不再调用模型', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '通用图片描述' } }] })),
    );
    vi.stubGlobal('fetch', fetch);
    const f = fixture();
    await Promise.all([
      f.processor.prepare({ feature: 'assistant', text: '', images: [image] }),
      f.processor.prepare({ feature: 'profile', text: '', images: [image] }),
    ]);
    await f.processor.prepare({ feature: 'cloneTraining', text: '', images: [image] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(f.deps.ocr).not.toHaveBeenCalled();
  });
});
