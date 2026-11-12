import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MessageMediaLocation, MessageMediaTarget } from '../src/shared/message_media';
import { MESSAGE_MEDIA_LOCATION_LABELS } from '../src/shared/message_media';

const state = vi.hoisted(() => ({
  locations: [] as MessageMediaLocation[],
  reveal: vi.fn(async (_input: unknown) => true),
  toast: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      mediaResource: { messageLocations: { useQuery: () => ({ data: state.locations }) } },
    },
  },
  client: { account: { mediaResource: { revealMessageMedia: { mutate: state.reveal } } } },
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: (select: (store: { push: typeof state.toast }) => unknown) =>
    select({ push: state.toast }),
}));
import { MessageMediaRevealAction } from '../src/renderer/src/components/MessageMediaRevealAction';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
const target: MessageMediaTarget = {
  kind: 'mface',
  t: 1,
  name: '',
  token: '',
  md5: '',
  msgId: '1',
  conv: '2',
  pack: '100',
  hash: 'ab',
  label: '表情',
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.locations = [];
  state.reveal.mockReset().mockResolvedValue(true);
  state.toast.mockClear();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
async function mount(ready = true) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  const render = () =>
    act(async () =>
      root.render(
        h(MessageMediaRevealAction, { target, binding: ready ? binding : null, onClose: close }),
      ),
    );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  await render();
  return { host, render, close };
}
it('另存与缓存同时展示，点击携带各自的定位身份', async () => {
  state.locations = [
    { kind: 'saved', key: 'saved-file', available: true },
    { kind: 'cache', key: 'cache-file', available: true },
  ];
  const f = await mount();
  const buttons = [...f.host.querySelectorAll('button')];
  expect(buttons.map((button) => button.textContent)).toEqual(['显示另存文件', '显示缓存文件']);
  for (const [index, button] of buttons.entries()) {
    await act(async () => button.click());
    expect(state.reveal).toHaveBeenLastCalledWith({
      ...binding,
      target,
      location: { kind: state.locations[index].kind, key: state.locations[index].key },
    });
  }
  expect(f.close).toHaveBeenCalledTimes(2);
});
it('删除另存文件后仍可点击查看失效原因，不自动触发缓存定位或保存', async () => {
  state.locations = [
    { kind: 'saved', key: 'saved-file', available: false },
    { kind: 'cache', key: 'cache-file', available: true },
  ];
  state.reveal.mockRejectedValueOnce(new Error('另存的文件已被移动或删除，请使用“另存为”重新保存'));
  const f = await mount();
  const button = f.host.querySelector<HTMLButtonElement>('[aria-label="显示另存文件"]')!;
  expect(button.disabled).toBe(false);
  expect(button.title).toContain('已被移动或删除');
  await act(async () => button.click());
  expect(state.reveal).toHaveBeenCalledOnce();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: expect.stringContaining('另存的文件已被移动或删除') }),
  );
});
it('只有存在对应对象才显示按钮，缩略图与封面使用准确名称', async () => {
  const f = await mount();
  expect(f.host.querySelector('button')).toBeNull();
  state.locations = Object.keys(MESSAGE_MEDIA_LOCATION_LABELS).map((kind) => ({
    kind: kind as MessageMediaLocation['kind'],
    key: kind,
    available: true,
  }));
  await f.render();
  expect([...f.host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(
    Object.values(MESSAGE_MEDIA_LOCATION_LABELS),
  );
  const notReady = await mount(false);
  expect(notReady.host.querySelector('button')).toBeNull();
});
