import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useGeneratedSelection } from '../src/renderer/src/views/agentlab/useGeneratedSelection';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';

const copied = vi.hoisted(() => vi.fn(async (_value: string) => true));
vi.mock('../src/renderer/src/im-template/template/clipboard', () => ({
  copyTextToClipboard: copied,
}));
afterEach(() => {
  copied.mockClear();
  vi.unstubAllGlobals();
});
const messages = [
  { id: 'a', text: '第一条' },
  { id: 'b', text: '第二条' },
  { id: 'c', text: '未选消息' },
];

function mount(kind: 'persona' | 'group') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture({ rows }: { rows: typeof messages }) {
    const selection = useGeneratedSelection(
      { kind, ownerId: 'owner', sessionId: 'session' },
      rows,
      true,
    );
    const request = useContentExportRequest();
    return h(
      'div',
      null,
      h(
        'button',
        { 'aria-label': '模拟消息右键多选', onClick: () => selection.selectMessage('b') },
        '多选',
      ),
      h(
        'div',
        { ...selection.rootProps, id: 'selection-root' },
        rows.map((row) => h('div', { ...selection.itemProps(row.id), key: row.id }, row.text)),
      ),
      selection.toolbar,
      h('output', null, JSON.stringify(request?.selection ?? null)),
    );
  }
  const render = (rows = messages) =>
    act(() => root.render(h(ContentSelectionProvider, null, h(Fixture, { rows }))));
  render();
  return {
    host,
    render,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it.each(['persona', 'group'] as const)(
  '%s 底部操作栏按时间线顺序复制和精确导出，不扩大成整场会话',
  async (kind) => {
    const f = mount(kind);
    try {
      act(() =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="模拟消息右键多选"]')!.click(),
      );
      act(() => f.host.querySelector<HTMLElement>('[data-weq-select-id="a"]')!.click());
      expect(f.host.querySelector('.selection-bar-info')?.getAttribute('aria-label')).toBe(
        '已选 2 条消息',
      );
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="复制"]')!.click(),
      );
      expect(copied).toHaveBeenCalledWith('第一条\n第二条');
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="导出所选消息"]')!.click());
      expect(JSON.parse(f.host.querySelector('output')!.textContent!)).toEqual({
        owner: { kind: 'clone-messages', container: JSON.stringify([kind, 'owner', 'session']) },
        scope: { type: 'items', ids: ['a', 'b'] },
      });
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
      expect(f.host.querySelector('.selection-bar')).toBeNull();
    } finally {
      f.close();
    }
  },
);

it('已选消息缺失时禁用复制和导出，Escape 仍可退出多选', () => {
  const f = mount('persona');
  try {
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="模拟消息右键多选"]')!.click());
    f.render([]);
    expect(f.host.querySelector<HTMLButtonElement>('[aria-label="复制"]')?.disabled).toBe(true);
    const exportButton = f.host.querySelector<HTMLButtonElement>('[aria-label="导出所选消息"]')!;
    expect(exportButton.disabled).toBe(true);
    act(() => exportButton.click());
    expect(f.host.querySelector('output')?.textContent).toBe('null');
    act(() =>
      f.host
        .querySelector('#selection-root')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(f.host.querySelector('.selection-bar')).toBeNull();
  } finally {
    f.close();
  }
});
