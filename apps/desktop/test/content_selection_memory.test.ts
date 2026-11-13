import { act, createElement as h, useState, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ContentSelectionProvider,
  useContentMultiSelect,
  useContentSelectionScope,
  useCurrentContentSelection,
} from '../src/renderer/src/state/contentSelection';
import { useMultiSelection } from '../src/renderer/src/hooks/useMultiSelection';
import {
  contentReferenceKey,
  type ContentOwner,
  type ContentReference,
} from '../src/shared/content_selection';

afterEach(() => vi.unstubAllGlobals());
it('切换相册保留精确照片引用，退出只清当前工作区且不串账号来源', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Panel({ album, source }: { album: string; source: string }) {
    useContentSelectionScope(source);
    const ref: ContentReference = {
      kind: 'group-photo',
      groupCode: '1',
      albumId: album,
      mediaKey: 'same-name',
    };
    const key = contentReferenceKey(ref);
    const selection = useContentMultiSelect(
      { kind: 'group-albums', container: '1' },
      true,
      new Map([[key, ref]]),
    );
    return h(
      'section',
      null,
      h(
        'button',
        { onClick: () => selection.setSelectedIds((previous) => new Set([...previous, key])) },
        '选中',
      ),
      h('output', null, JSON.stringify(selection.references)),
    );
  }
  const render = (album: string, source = 'account-a') =>
    act(() => root.render(h(ContentSelectionProvider, null, h(Panel, { album, source }))));
  try {
    render('a');
    act(() => host.querySelector('button')!.click());
    render('b');
    act(() => host.querySelector('button')!.click());
    expect(
      JSON.parse(host.querySelector('output')!.textContent!).map(
        (item: { albumId: string }) => item.albumId,
      ),
    ).toEqual(['a', 'b']);
    render('a');
    expect(JSON.parse(host.querySelector('output')!.textContent!)).toHaveLength(2);
    render('a', 'account-b');
    expect(JSON.parse(host.querySelector('output')!.textContent!)).toEqual([]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
it('会话和页面分别保留模式、选区和 Shift 锚点，换来源整体清空', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const owners: Record<string, ContentOwner> = {
    a: { kind: 'messages', container: 'group:a' },
    b: { kind: 'messages', container: 'group:b' },
    contacts: { kind: 'contacts', container: 'friends' },
  };
  function Panel({ name }: { name: string }) {
    const selection = useContentMultiSelect(owners[name]!);
    const multi = useMultiSelection({
      ids: ['1', '2', '3'],
      selected: selection.selectedIds,
      onChange: selection.setSelectedIds,
      enabled: selection.selectionMode,
      onStart: () => selection.setSelectionMode(true),
      anchorRef: selection.anchorRef,
    });
    return h(
      'section',
      { ...multi.rootProps },
      h(
        'output',
        null,
        JSON.stringify({
          mode: selection.selectionMode,
          ids: [...selection.selectedIds],
          anchor: selection.anchorRef.current,
        }),
      ),
      ...['1', '2', '3'].map((id) =>
        h('button', { key: id, 'data-item': id, onClick: (event) => multi.toggle(id, event) }, id),
      ),
      h('button', { 'data-exit': true, onClick: () => selection.setSelectionMode(false) }, '退出'),
    );
  }
  function View({ source }: { source: string }) {
    const [name, setName] = useState('a');
    useContentSelectionScope(source);
    return h(
      'main',
      null,
      ...Object.keys(owners).map((name) =>
        h('button', { key: name, 'data-page': name, onClick: () => setName(name) }, name),
      ),
      h(Panel, { key: `panel:${name}`, name }),
    );
  }
  const render = (source = 'source-a') =>
    act(() =>
      root.render(h(StrictMode, null, h(ContentSelectionProvider, null, h(View, { source })))),
    );
  const click = (selector: string, shiftKey = false) =>
    act(() =>
      host
        .querySelector(selector)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey })),
    );
  const state = () => JSON.parse(host.querySelector('output')!.textContent!);
  try {
    render();
    click('[data-item="1"]');
    click('[data-page="b"]');
    click('[data-item="2"]');
    click('[data-page="contacts"]');
    click('[data-item="3"]');
    click('[data-page="a"]');
    expect(state()).toEqual({ mode: true, ids: ['1'], anchor: '1' });
    click('[data-item="3"]', true);
    expect(state().ids).toEqual(['1', '2', '3']);
    expect(state().anchor).toBe('1');
    click('[data-exit]');
    click('[data-page="b"]');
    expect(state()).toEqual({ mode: true, ids: ['2'], anchor: '2' });
    click('[data-page="contacts"]');
    expect(state().ids).toEqual(['3']);
    render('source-b');
    expect(state()).toEqual({ mode: false, ids: [], anchor: null });
    click('[data-page="a"]');
    expect(state().mode).toBe(false);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('空聊天面板不覆盖同屏侧栏多选，换到空联系人页不误用其他页面选区', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Sidebar() {
    const state = useContentMultiSelect({ kind: 'conversations', container: 'main-list' });
    return h(
      'button',
      { 'data-side': true, onClick: () => state.setSelectedIds(new Set(['peer'])) },
      '选侧栏',
    );
  }
  function Page({ kind, container }: { kind: 'messages' | 'contacts'; container: string }) {
    useContentMultiSelect({ kind, container });
    return null;
  }
  function Probe() {
    return h('output', null, JSON.stringify(useCurrentContentSelection()));
  }
  const render = (kind: 'messages' | 'contacts', container: string) =>
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          kind === 'messages' ? h(Sidebar) : null,
          h(Page, { kind, container }),
          h(Probe),
        ),
      ),
    );
  try {
    render('messages', 'group:a');
    act(() => host.querySelector<HTMLButtonElement>('[data-side]')!.click());
    render('messages', 'group:b');
    expect(JSON.parse(host.querySelector('output')!.textContent!).owner.kind).toBe('conversations');
    render('contacts', 'friends');
    expect(host.querySelector('output')!.textContent).toBe('null');
    render('messages', 'group:b');
    expect(JSON.parse(host.querySelector('output')!.textContent!).scope.ids).toEqual(['peer']);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
