import { afterEach, expect, it, vi } from 'vitest';
import { pcm16Samples, startRemoteMedia } from '../src/renderer/src/lib/remoteMedia';

afterEach(() => {
  delete window.weqRemoteMedia;
  vi.restoreAllMocks();
});

it('设备帧只投递给所属采集，取消后恰好停止一次', async () => {
  const stop = vi.fn();
  let id = '';
  window.weqRemoteMedia = {
    start: (options) => {
      id = options.id;
    },
    stop,
  };
  const controller = new AbortController();
  const audio = vi.fn();
  const emit = (detail: object) =>
    window.dispatchEvent(new CustomEvent('weq-remote-media', { detail }));
  const pending = startRemoteMedia({ audio: true }, { audio }, controller.signal);
  emit({ id, type: 'ready' });
  const close = await pending;
  emit({ id: 'other', type: 'audio', pcmBase64: 'AAA=' });
  expect(audio).not.toHaveBeenCalled();
  emit({ id, type: 'audio', pcmBase64: 'AIA=' });
  expect(pcm16Samples(audio.mock.calls[0]![0])[0]).toBe(-1);
  controller.abort();
  close();
  emit({ id, type: 'audio', pcmBase64: 'AAA=' });
  expect(stop).toHaveBeenCalledOnce();
  expect(audio).toHaveBeenCalledOnce();
});

it('尚未授权时取消也释放原生请求，不留下悬挂Promise', async () => {
  const stop = vi.fn();
  window.weqRemoteMedia = { start: vi.fn(), stop };
  const controller = new AbortController();
  const pending = startRemoteMedia({ audio: true }, {}, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('采集已取消');
  expect(stop).toHaveBeenCalledOnce();
});
