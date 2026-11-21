// @vitest-environment jsdom
import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommonRelationships } from '../src/renderer/src/components/qq-actions/CommonRelationships';
import { OverlayLayer } from '../src/renderer/src/components/OverlayLayer';
import { useViewState } from '../src/renderer/src/state/view';

vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
    available: true,
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: {
        useQuery: () => ({ data: { uin: '10001', configId: 'fixture' } }),
      },
      qqWrite: {
        commonRelationships: {
          useQuery: () => ({
            data: { friendCount: 1, groups: [{ groupCode: '10003', name: '合成共同群' }] },
          }),
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/exportAvatars', () => ({ GroupAvatar: () => null }));
vi.mock('../src/renderer/src/components/groupProfile/GroupProfileSurface', () => ({
  GroupProfileSurface: ({ onClose }: { onClose: () => void }) =>
    h(
      OverlayLayer,
      { presentation: 'popover', onClose },
      h('section', { role: 'dialog', 'aria-label': '群资料' }, h('button', null, '群资料内容')),
    ),
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  useViewState.setState({ openedUin: '10001' });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});

function mount() {
  const host = document.createElement('div');
  const trigger = document.createElement('button');
  document.body.append(trigger, host);
  trigger.focus();
  const close = vi.fn();
  function View() {
    const [open, setOpen] = useState(true);
    return open
      ? h(
          OverlayLayer,
          {
            presentation: 'popover',
            onClose: () => {
              close();
              setOpen(false);
            },
          },
          h(
            'section',
            { role: 'dialog', 'aria-label': '联系人资料' },
            h(CommonRelationships, { uin: '10002' }),
          ),
        )
      : null;
  }
  const root = createRoot(host);
  act(() => root.render(h(View)));
  const commonTrigger = document.querySelector<HTMLButtonElement>('[title="查看共同群列表"]')!;
  act(() => {
    commonTrigger.focus();
    commonTrigger.click();
  });
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
    trigger.remove();
  });
  return { close, commonTrigger, trigger };
}

function pressEscape() {
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  );
}

it.each(['inside', 'blank', 'outside'])(
  '共同群在 %s 聚焦时 Esc 只关闭列表并恢复入口焦点',
  (focus) => {
    const f = mount();
    if (focus === 'inside')
      act(() => document.querySelector<HTMLButtonElement>('.weq-common-groups-close')!.focus());
    if (focus === 'blank') act(() => (document.activeElement as HTMLElement).blur());
    if (focus === 'outside') act(() => f.commonTrigger.focus());
    if (focus === 'blank') expect(document.activeElement).toBe(document.body);
    expect(document.querySelector('.weq-common-groups-dialog')).not.toBeNull();
    pressEscape();
    expect(document.querySelector('.weq-common-groups-dialog')).toBeNull();
    expect(f.close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(f.commonTrigger);
    pressEscape();
    expect(f.close).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(f.trigger);
  },
);

it('共同群中的群名片失焦后仍先关闭名片，再关闭列表和联系人资料', async () => {
  const f = mount();
  const groupTrigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="查看 合成共同群 的群名片"]',
  )!;
  act(() => {
    groupTrigger.focus();
    groupTrigger.click();
  });
  await act(async () => vi.dynamicImportSettled());
  expect(document.querySelector('[aria-label="群资料"]')).not.toBeNull();
  act(() => (document.activeElement as HTMLElement).blur());
  pressEscape();
  expect(document.querySelector('[aria-label="群资料"]')).toBeNull();
  expect(document.querySelector('.weq-common-groups-dialog')).not.toBeNull();
  expect(document.activeElement).toBe(groupTrigger);
  expect(f.close).not.toHaveBeenCalled();
  pressEscape();
  expect(document.querySelector('.weq-common-groups-dialog')).toBeNull();
  expect(document.activeElement).toBe(f.commonTrigger);
  pressEscape();
  expect(f.close).toHaveBeenCalledOnce();
});
