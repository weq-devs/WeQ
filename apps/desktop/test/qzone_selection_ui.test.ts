import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QzoneView } from '../src/renderer/src/views/QzoneView';
import {
  ContentSelectionProvider,
  useContentExportRequest,
  useCurrentContentSelection,
} from '../src/renderer/src/state/contentSelection';
import { QzoneScopePicker } from '../src/renderer/src/views/export/QzoneScopePicker';

const fixture = vi.hoisted(() => ({
  posts: vi.fn(async (_input: unknown) => ({
    total: 3,
    nickname: '合成空间',
    list: ['a', 'b', 'c'].map((tid) => ({
      tid,
      content: `fixture-${tid}`,
      time: 1,
      images: [],
      videos: [],
      isPrivate: false,
      commentNum: 0,
    })),
  })),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      qzone: {
        posts: { query: fixture.posts },
        detail: {
          query: async () => ({
            post: {
              tid: 'linked',
              content: 'fixture-linked',
              time: 1,
              images: [],
              videos: [],
              isPrivate: false,
              commentNum: 0,
            },
          }),
        },
        stats: { query: async () => ({ postCount: 3, photoCount: 0 }) },
        people: { query: async () => ({}) },
        cancel: { mutate: async () => {} },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({
  QqAvatar: () => createElement('span', null, '头像'),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
it('空间正文不显示重复按钮，修饰键多选仍可通过顶部导出交出离散 tid', async () => {
  function Probe() {
    return createElement(
      'output',
      null,
      JSON.stringify({
        selection: useCurrentContentSelection(),
        request: useContentExportRequest(),
      }),
    );
  }
  const f = mount(
    createElement(
      ContentSelectionProvider,
      null,
      createElement(QzoneView, {
        selfUin: '10001',
        nickname: '合成自己',
        active: true,
        spaceRequest: { accountUin: '10001', uin: '10001', revision: 'fixture-1' },
      }),
      createElement(Probe),
    ),
  );
  try {
    await act(async () => {});
    expect(f.host.querySelector('[aria-label="多选说说"]')).toBeNull();
    expect(f.host.querySelector('[aria-label="导出说说范围"]')).toBeNull();
    expect(f.host.querySelectorAll('[aria-label="导出说说"]')).toHaveLength(1);
    act(() => {
      f.host
        .querySelector<HTMLElement>('[data-qzone-tid="a"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    act(() => {
      f.host.querySelector<HTMLElement>('[data-qzone-tid="c"]')!.click();
    });
    expect(f.host.querySelectorAll('.weq-qzn-post.is-selected')).toHaveLength(2);
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="导出说说"]')!.click());
    const state = JSON.parse(f.host.querySelector('output')!.textContent!);
    expect(state.selection).toEqual({
      owner: { kind: 'qzone-posts', container: '10001' },
      scope: { type: 'items', ids: ['a', 'c'] },
    });
    expect(state.request.selection).toEqual(state.selection);
    act(() => f.host.querySelector<HTMLElement>('[data-qzone-tid="b"]')!.click());
    expect(
      JSON.parse(f.host.querySelector('output')!.textContent!).request.selection.scope.ids,
    ).toEqual(['a', 'c']);
    expect(f.host.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  } finally {
    f.close();
  }
});
it('跳转说说详情和普通动态共用一列阅读布局，不嵌套两层时间线边距', async () => {
  const f = mount(
    createElement(QzoneView, {
      selfUin: '10001',
      nickname: '合成自己',
      active: true,
      spaceRequest: {
        accountUin: '10001',
        uin: '10002',
        revision: 'fixture-linked',
        target: { kind: 'post', tid: 'linked' },
      },
    }),
  );
  try {
    await act(async () => {});
    const linked = f.host.querySelector('.weq-qzn-linked-post');
    expect(linked?.textContent).toContain('fixture-linked');
    const timeline = linked?.closest('.weq-qzn-timeline');
    expect(timeline).not.toBeNull();
    expect(timeline?.querySelector('[data-qzone-tid="a"]')).not.toBeNull();
    expect(timeline?.querySelector('.weq-qzn-timeline')).toBeNull();
  } finally {
    f.close();
  }
});
it('空间范围只在精确模式按需读取，保留未载入 tid，不让新页自动扩选', async () => {
  const change = vi.fn();
  const f = mount(
    createElement(QzoneScopePicker, {
      selfUin: '10001',
      hostUin: '10002',
      selected: ['a', 'later'],
      onChange: change,
    }),
  );
  try {
    await act(async () => {});
    expect(fixture.posts).toHaveBeenCalledWith(
      expect.objectContaining({ hostUin: '10002', offset: 0, requestId: expect.any(String) }),
    );
    expect(f.host.textContent).toContain('当前列表之外已选 1 条');
    expect(change).not.toHaveBeenCalled();
    act(() => f.host.querySelectorAll<HTMLElement>('.weq-qzone-scope-row')[2]!.click());
    expect(change).toHaveBeenCalledWith(['a', 'later', 'c']);
  } finally {
    f.close();
  }
  fixture.posts.mockClear();
  const all = mount(
    createElement(QzoneScopePicker, {
      selfUin: '10001',
      hostUin: '10002',
      selected: undefined,
      onChange: change,
    }),
  );
  try {
    await act(async () => {});
    expect(fixture.posts).not.toHaveBeenCalled();
  } finally {
    all.close();
  }
});
