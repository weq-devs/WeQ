import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupAlbumDialog } from '../src/renderer/src/components/GroupAlbumDialog';
import { GroupFileDialog } from '../src/renderer/src/components/GroupFileDialog';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import {
  CONTENT_CATEGORY_ORDER,
  contentCoverageText,
  isContentSearchHit,
  type ContentSearchHit,
} from '../src/renderer/src/components/search/types';

const rpc = vi.hoisted(() => ({
  album: vi.fn(async (_input: unknown) => []),
  files: vi.fn(async (_input: unknown) => ({
    targetDirectory: 'nested',
    folders: [],
    files: ['other', 'target'].map((fileId) => ({
      fileId,
      fileName: '同名.txt',
      fileSize: 1,
      uploadedTime: 0,
      uploaderName: '',
      busId: 1,
    })),
  })),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({}),
    account: {
      getAccountConfig: { useQuery: () => ({ data: undefined }) },
      getGroupAlbumAccessState: { useQuery: () => ({ data: { qqOnline: false } }) },
      qqActions: {
        fileSummary: { useQuery: () => ({ data: undefined }) },
        folders: { useQuery: () => ({ data: undefined }) },
        groupPermissions: { useQuery: () => ({ data: undefined }) },
      },
    },
  },
  client: {
    account: {
      getGroupAlbumAccessState: { query: async () => ({ qqOnline: true }) },
      listGroupAlbumMedia: { query: rpc.album },
      listGroupFiles: { query: rpc.files },
    },
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
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
it('来源不可用与空缓存分别呈现，不暗示已经搜索完整历史', () => {
  expect(
    contentCoverageText({
      scope: 'local-database',
      records: 0,
      limited: false,
      updatedAt: null,
      available: false,
    }),
  ).toBe('本地来源尚不可用');
  expect(
    contentCoverageText({ scope: 'observed-cache', records: 0, limited: false, updatedAt: null }),
  ).toBe('已缓存内容 · 0 条');
});
it('同名相册跳转使用精确 id，群文件读取目标目录并高亮精确文件', async () => {
  const albums = ['other', 'target'].map((id) => ({
    id,
    title: '同名相册',
    photoCount: 0,
    coverUrl: '',
    desc: '',
    createUin: 0,
    createNickname: '',
    createTime: '',
    updateTime: '',
  }));
  const a = mount(
    createElement(GroupAlbumDialog, {
      groupCode: '50001',
      groupName: '合成群',
      initialAlbums: albums,
      initialAlbumId: 'target',
      onClose: vi.fn(),
    }),
  );
  try {
    await act(async () => {});
    expect(rpc.album).toHaveBeenCalledWith({ groupCode: '50001', albumId: 'target' });
  } finally {
    a.close();
  }
  const f = mount(
    createElement(GroupFileDialog, {
      groupCode: '50001',
      groupName: '合成群',
      initialFolderId: 'nested',
      initialFileId: 'target',
      onClose: vi.fn(),
    }),
  );
  try {
    await act(async () => {});
    expect(rpc.files).toHaveBeenCalledWith({ groupCode: '50001', folderId: 'nested' });
    expect(
      document.querySelector('.group-file-dialog .is-search-hit')?.getAttribute('data-file-id'),
    ).toBe('target');
    expect(document.querySelectorAll('.group-file-dialog .is-search-hit')).toHaveLength(1);
  } finally {
    f.close();
  }
});
it('已删除的相册和文件明确说明，不自动改选第一条', async () => {
  const a = mount(
    createElement(GroupAlbumDialog, {
      groupCode: '50001',
      groupName: '合成群',
      initialAlbums: [],
      initialAlbumId: 'deleted',
      onClose: vi.fn(),
    }),
  );
  try {
    await act(async () => {});
    expect(document.body.textContent).toContain('搜索命中的相册不存在');
    expect(rpc.album).not.toHaveBeenCalled();
  } finally {
    a.close();
  }
  const f = mount(
    createElement(GroupFileDialog, {
      groupCode: '50001',
      groupName: '合成群',
      initialFolderId: 'nested',
      initialFileId: 'deleted',
      onClose: vi.fn(),
    }),
  );
  try {
    await act(async () => {});
    expect(document.body.textContent).toContain('搜索命中的文件已删除');
    expect(document.querySelector('.group-file-dialog .is-search-hit')).toBeNull();
  } finally {
    f.close();
  }
});
it('新增结果真实渲染并交出稳定目标，来源覆盖不是“全部历史”', () => {
  const hit: ContentSearchHit = {
    category: 'qzonePost',
    id: 'fixture',
    target: { kind: 'qzonePost', uin: '10001', tid: 'post' },
    title: '合成作者',
    content: 'needle 正文',
    sourceName: '合成空间',
    time: 1,
    observedAt: 1,
  };
  const select = vi.fn();
  const f = mount(
    createElement(SearchDropdown, {
      keyword: 'needle',
      quick: null,
      quickLoading: false,
      slowLoading: false,
      slow: {
        collections: [],
        chatRecords: [],
        files: [],
        cloneMessages: [],
        assistantMessages: [],
        indexStatus: 'disabled',
        contentHits: [hit],
        contentCoverage: {
          qzonePost: { scope: 'observed-cache', records: 1, limited: true, updatedAt: 1 },
        },
      },
      categories: CONTENT_CATEGORY_ORDER,
      onCategoriesChange: vi.fn(),
      onSelect: select,
      onMore: vi.fn(),
    }),
  );
  try {
    expect(isContentSearchHit(hit)).toBe(true);
    expect(f.host.textContent).toContain('已缓存内容 · 1 条 · 缓存有回收或截断');
    act(() => f.host.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(select).toHaveBeenCalledWith(hit);
  } finally {
    f.close();
  }
});
