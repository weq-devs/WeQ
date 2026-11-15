// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  media: vi.fn(),
  decode: vi.fn(() => ({ width: 1, height: 1, data: new Uint8Array(3) })),
  engine: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => ({ bootstrap: null }) }));
vi.mock('../src/main/media_protocol', () => ({ handleMediaRequest: fixture.media }));
vi.mock('../src/main/ocr/image', () => ({
  decodeImageBytes: fixture.decode,
  decodeImageDataUrl: fixture.decode,
}));
vi.mock('../src/main/ocr/engine', () => ({ runOcrEngine: fixture.engine }));
vi.mock('../src/main/enhancements/engine_environment', () => ({
  enhancementEngineAvailable: () => true,
}));
import { runLocalOcr } from '../src/main/ocr/local';
const model = { modelId: 'synthetic', paths: { det: 'det', rec: 'rec', dict: 'dict' } };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it('远程来源超限在解码前拒绝并关闭正文', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), {
    headers: { 'content-length': String(33 * 1024 * 1024) },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  await expect(runLocalOcr('https://synthetic.invalid/image', model)).rejects.toThrow('大小上限');
  expect(cancel).toHaveBeenCalled();
  expect(fixture.decode).not.toHaveBeenCalled();
});
it('调用方已取消时不继续取图', async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1])));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  controller.abort(new Error('synthetic cancelled'));
  await expect(
    runLocalOcr('https://synthetic.invalid/image', model, controller.signal),
  ).rejects.toThrow('synthetic cancelled');
  expect(fetcher).not.toHaveBeenCalled();
});
it('媒体协议仍走现有完整取图服务并把取消信号传入', async () => {
  fixture.media.mockResolvedValueOnce(new Response(new Uint8Array([1])));
  fixture.engine.mockResolvedValueOnce({
    ok: true,
    blocks: [],
    imageWidth: 1,
    imageHeight: 1,
    elapsedMs: 1,
  });
  await runLocalOcr('weq-media://pic?token=synthetic', model);
  expect(fixture.media.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  expect(fixture.engine).toHaveBeenCalledOnce();
});
it('响应头已返回但正文挂起时到期限取消', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new ReadableStream({ cancel }))),
  );
  const work = runLocalOcr('https://synthetic.invalid/slow', model);
  const outcome = work.catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await outcome).toBeInstanceOf(Error);
  expect(cancel).toHaveBeenCalled();
});
