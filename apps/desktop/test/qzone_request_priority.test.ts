import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useQzoneRequests } from '../src/renderer/src/hooks/useQzoneRequests';

const cancel = vi.hoisted(() => ({ qzone: vi.fn(), qzonePublic: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      qzone: { cancel: { mutate: cancel.qzone } },
      qzonePublic: { cancel: { mutate: cancel.qzonePublic } },
    },
  },
}));

it('空间后台补全等待时，前台可立即发请求，退出只在电脑取消已发出的读取', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  cancel.qzone.mockReset().mockResolvedValue(undefined);
  cancel.qzonePublic.mockReset().mockResolvedValue(undefined);
  const root = createRoot(document.createElement('div'));
  let requests!: ReturnType<typeof useQzoneRequests>;
  function Probe() {
    requests = useQzoneRequests('qzonePublic');
    return null;
  }
  act(() => root.render(createElement(Probe)));
  const sent: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const background = vi.fn(async (id: string) => {
    sent.push(id);
    await held;
  });
  const queued = vi.fn(() => held);
  const foreground = vi.fn(async () => '当前页面');
  const completions = [
    requests.run(background, true).catch((error: unknown) => error),
    requests.run(queued, true).catch((error: unknown) => error),
  ];
  try {
    await vi.waitFor(() => expect(background).toHaveBeenCalledOnce());
    const visible = requests.run(foreground);
    completions.push(visible);
    expect(queued).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(foreground).toHaveBeenCalledOnce());
    await expect(visible).resolves.toBe('当前页面');

    requests.cancel();
    await vi.waitFor(() => expect(cancel.qzonePublic).toHaveBeenCalledOnce());
    expect(cancel.qzonePublic).toHaveBeenCalledWith({ requestId: sent[0] });
    expect(cancel.qzone).not.toHaveBeenCalled();
    const [activeResult, queuedResult] = await Promise.all(completions.slice(0, 2));
    expect(activeResult).toMatchObject({ name: 'AbortError' });
    expect(queuedResult).toMatchObject({ name: 'AbortError' });
    expect(queued).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    release();
    await Promise.allSettled(completions);
    vi.unstubAllGlobals();
  }
});
