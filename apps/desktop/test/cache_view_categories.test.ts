import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CacheView } from '../src/renderer/src/views/cache/CacheView';

// 各分类浏览器各自有数据层，这里只验证分类骨架，全部换成占位节点。
vi.mock('../src/renderer/src/views/cache/AvatarExplorer', () => ({ AvatarExplorer: () => '头像' }));
vi.mock('../src/renderer/src/views/cache/SysEmojiExplorer', () => ({
  SysEmojiExplorer: () => '系统表情',
}));
vi.mock('../src/renderer/src/views/cache/MarketEmojiExplorer', () => ({
  MarketEmojiExplorer: () => '商城表情',
}));
vi.mock('../src/renderer/src/views/cache/MarketPackExplorer', () => ({
  MarketPackExplorer: () => '商城表情包',
}));
vi.mock('../src/renderer/src/views/cache/CustomEmojiExplorer', () => ({
  CustomEmojiExplorer: () => '自定义表情',
}));
vi.mock('../src/renderer/src/views/cache/RelatedEmojiExplorer', () => ({
  RelatedEmojiExplorer: () => '关联表情',
}));
vi.mock('../src/renderer/src/views/cache/FileDirExplorer', () => ({
  FileDirExplorer: () => 'File 目录',
}));
vi.mock('../src/renderer/src/views/cache/DownloadFileExplorer', () => ({
  DownloadFileExplorer: () => '下载文件',
}));
vi.mock('../src/renderer/src/views/cache/MediaResourceExplorers', () => ({
  FlatMediaExplorer: ({ kind }: { kind: string }) => `平铺:${kind}`,
  MonthMediaExplorer: ({ kind }: { kind: string }) => `按月:${kind}`,
  VoiceExplorer: () => '语音',
}));
afterEach(() => vi.unstubAllGlobals());

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(CacheView)));
  return {
    host,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('本地缓存按表情 / 头像 / 图片与视频 / 文件 / 语音 / 空间分组，且不再重复数据库', () => {
  const f = mount();
  try {
    const groups = [...f.host.querySelectorAll('.weq-cache-cat-group')].map((group) => ({
      name: group.querySelector('.weq-cache-cat-group-label')?.textContent,
      items: [...group.querySelectorAll('.weq-cache-cat strong')].map((item) => item.textContent),
    }));
    expect(groups).toEqual([
      { name: '表情', items: ['系统表情', '商城表情', '商城表情包', '自定义表情', '关联表情'] },
      { name: '头像', items: ['头像资源'] },
      { name: '图片与视频', items: ['图片资源', '视频资源', '图片墙资源'] },
      { name: '文件', items: ['File 目录', '下载文件'] },
      { name: '语音', items: ['语音资源'] },
      { name: '空间', items: ['QQ空间缓存'] },
    ]);
    // 数据库是维护工具里的独立入口，不应再出现在缓存分类里。
    expect(f.host.textContent).not.toContain('本地数据库');
  } finally {
    f.dispose();
  }
});

it('页内不再重复整体分析与清理释放入口，只保留分类浏览', () => {
  const f = mount();
  try {
    // 整体分析 / 清理释放已收在维护工具外层入口，页内只保留分类栏与内容区。
    expect(f.host.textContent).not.toContain('整体分析');
    expect(f.host.textContent).not.toContain('清理释放');
    expect(f.host.querySelectorAll('.weq-cache-analyze-btn')).toHaveLength(0);
    expect(f.host.querySelectorAll('.weq-cache-analyze-rail')).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it('切换分类渲染对应浏览器，默认选中第一个分类', () => {
  const f = mount();
  try {
    expect(f.host.querySelector('.weq-cache-pane')?.textContent).toBe('系统表情');
    const video = [...f.host.querySelectorAll<HTMLButtonElement>('.weq-cache-cat')].find((button) =>
      button.textContent?.includes('视频资源'),
    )!;
    act(() => video.click());
    expect(f.host.querySelector('.weq-cache-pane')?.textContent).toBe('按月:video');
  } finally {
    f.dispose();
  }
});
