// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { handleMediaRequest } from '../src/main/media_protocol';

const state = vi.hoisted(() => ({
  loaded: 0,
  source: '',
  wav: '',
  isSilk: false,
  decode: vi.fn(async (_source: string): Promise<string | null> => state.wav),
}));
vi.mock('../src/main/voice', () => {
  state.loaded++;
  return { decodeSilkToWav: state.decode, isSilkFile: () => state.isSilk };
});
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {
      fileResource: { resolveLocalFile: async () => state.source },
      mediaResource: { resolveFile: async () => state.source },
      fileSearch: { findFile: async () => ({ source: state.source }) },
    },
  }),
}));

it('普通媒体和缺失语音不加载编解码器，首次语音加载后各播放入口仍正确返回', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weq-voice-loading-'));
  try {
    expect(state.loaded).toBe(0);
    state.source = join(directory, 'plain.wav');
    state.wav = join(directory, 'decoded.wav');
    writeFileSync(state.source, 'synthetic original');
    writeFileSync(state.wav, 'synthetic decoded');
    expect(
      await (await handleMediaRequest(new Request('weq-media://localfile?path=plain'))).text(),
    ).toBe('synthetic original');
    state.source = '';
    expect(
      (await handleMediaRequest(new Request('weq-media://localvoice?rel=missing'))).status,
    ).toBe(404);
    expect(state.loaded).toBe(0);
    state.source = join(directory, 'plain.wav');
    const voice = new Request('weq-media://localfilevoice?path=plain');
    expect(await (await handleMediaRequest(voice)).text()).toBe('synthetic original');
    expect(state.loaded).toBe(1);
    expect(state.decode).not.toHaveBeenCalled();
    state.isSilk = true;
    for (const url of [
      voice.url,
      'weq-media://localvoice?rel=synthetic.silk',
      'weq-media://ptt?t=1&name=synthetic.silk',
    ]) {
      expect(await (await handleMediaRequest(new Request(url))).text()).toBe('synthetic decoded');
    }
    expect(state.loaded).toBe(1);
    expect(state.decode).toHaveBeenCalledTimes(3);
    expect(state.decode).toHaveBeenLastCalledWith(state.source);
    state.decode.mockResolvedValueOnce(null);
    expect((await handleMediaRequest(voice)).status).toBe(404);

    let finish!: (path: string) => void;
    state.decode.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const controller = new AbortController();
    const cancelled = handleMediaRequest(new Request(voice.url, { signal: controller.signal }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort();
    expect(await cancelled).toMatchObject({ status: 499, body: null });
    finish(state.wav);
    const range = await handleMediaRequest(new Request(voice, { headers: { Range: 'bytes=0-8' } }));
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('synthetic');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
