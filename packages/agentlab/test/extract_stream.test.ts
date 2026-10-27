import { afterEach, expect, it, vi } from 'vitest';
import { extractPersonaCard } from '../src/extract';
import { DEFAULT_API_TIMEOUT_MS } from '../src/api_usage';
import type { AgentLabEndpoint, AgentLabModelOutput, AgentLabPersonaStats } from '../src/types';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const stats = {} as AgentLabPersonaStats;
function fixture() {
  const output: AgentLabModelOutput[] = [];
  const endpoint: AgentLabEndpoint = {
    baseUrl: 'https://fixture.invalid',
    apiKey: 'fixture',
    model: 'fixture',
    onOutput: (event) => output.push(event),
  };
  return { endpoint, output };
}
function sse(text: string) {
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

it('默认模型请求期限为 3600 秒', () => {
  expect(DEFAULT_API_TIMEOUT_MS).toBe(3_600_000);
});

it('增量提炼同时展示正文和推理，兼容跨字节与 CRLF 分片、尾部用量帧', async () => {
  const f = fixture();
  const bytes = new TextEncoder().encode(
    [
      'data: {"choices":[{"delta":{"reasoning_content":"分析"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"{\\"tone\\":\\"温柔\\"}"},"finish_reason":"stop"}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"total_tokens":12}}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ].join(''),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).stream).toBe(true);
      return new Response(
        new ReadableStream({
          start(c) {
            for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
            c.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  );
  const usage = vi.fn();
  const card = await extractPersonaCard(
    { ...f.endpoint, onUsage: usage },
    '合成人物',
    stats,
    '夹具',
  );
  expect(card.tone).toBe('温柔');
  expect(f.output.filter((e) => e.text).map((e) => [e.channel, e.text])).toEqual([
    ['reasoning', '分析'],
    ['content', '{"tone":"温柔"}'],
  ]);
  expect(new Set(f.output.map((e) => e.requestId)).size).toBe(1);
  expect(f.output.at(-1)?.status).toBe('success');
  expect(usage).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: 'success', totalTokens: 12, stream: true }),
  );
});

it('流中断即使已有合法 JSON 也不能当作提炼成功或自动重发', async () => {
  const f = fixture();
  const fetch = vi.fn(async () =>
    sse('data: {"choices":[{"delta":{"content":"{\\"tone\\":\\"夹具\\"}"}}]}\n\n'),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(extractPersonaCard(f.endpoint, '夹具', stats, '夹具')).rejects.toThrow('中断');
  expect(fetch).toHaveBeenCalledOnce();
  expect(f.output.at(-1)?.status).toBe('failed');
});

it('取消等待中的读取，账目标为取消并释放 reader', async () => {
  const f = fixture();
  const controller = new AbortController();
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
  );
  const pending = extractPersonaCard(
    { ...f.endpoint, signal: controller.signal },
    '夹具',
    stats,
    '夹具',
  );
  const checked = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.output).not.toHaveLength(0));
  controller.abort();
  await checked;
  expect(cancel).toHaveBeenCalled();
  expect(f.output.at(-1)?.status).toBe('cancelled');
});

it('请求 stream 的兼容端点返回普通 JSON 时仍展示正文', async () => {
  const f = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ choices: [{ message: { content: '{"tone":"夹具"}' } }] })),
  );
  expect((await extractPersonaCard(f.endpoint, '夹具', stats, '夹具')).tone).toBe('夹具');
  expect(f.output.some((e) => e.text === '{"tone":"夹具"}')).toBe(true);
});

it('收到 DONE 就完成，不等待服务端关闭连接', async () => {
  const f = fixture();
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"{\\"tone\\":\\"夹具\\"}"}}]}\n\ndata: [DONE]\n\n',
                ),
              );
            },
            cancel,
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
  );
  expect((await extractPersonaCard(f.endpoint, '夹具', stats, '夹具')).tone).toBe('夹具');
  expect(cancel).toHaveBeenCalled();
});

it('流式读取沿用 3600 秒总期限，覆盖请求头到正文且释放计时器', async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }),
    ),
  );
  const pending = extractPersonaCard(f.endpoint, '夹具', stats, '夹具').catch((error) => error);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(f.output.at(-1)?.status).toBe('running');
  await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS - 180_000);
  expect((await pending).message).toContain('模型请求超时');
  expect(f.output.at(-1)?.status).toBe('failed');
  expect(vi.getTimerCount()).toBe(0);
});

it('明确拒绝温度只在尚无输出时去参回退，不重发部分生成', async () => {
  const f = fixture();
  const rejection = 'data: {"error":{"message":"Unsupported parameter: temperature"}}\n\n';
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(sse(rejection))
    .mockResolvedValueOnce(
      sse(
        'data: {"choices":[{"delta":{"content":"{\\"tone\\":\\"夹具\\"}"},"finish_reason":"stop"}]}\n\n',
      ),
    );
  vi.stubGlobal('fetch', fetch);
  expect((await extractPersonaCard(f.endpoint, '夹具', stats, '夹具')).tone).toBe('夹具');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[1]![1].body).temperature).toBeUndefined();
  fetch
    .mockReset()
    .mockResolvedValue(sse('data: {"choices":[{"delta":{"content":"部分输出"}}]}\n\n' + rejection));
  await expect(extractPersonaCard(f.endpoint, '夹具', stats, '夹具')).rejects.toThrow(
    'temperature',
  );
  expect(fetch).toHaveBeenCalledOnce();
});
