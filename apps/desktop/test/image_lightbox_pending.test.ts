import { act, createElement as h, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaPreviewHost } from '../src/renderer/src/components/mediaPreviewStore';
import { openMediaPreview } from '../src/renderer/src/components/mediaPreviewStore.shared';
import { QqImage } from '../src/renderer/src/components/QqMedia';
import {
  releaseAttachment,
  type ComposerAttachment,
} from '../src/renderer/src/im-template/template/composerMedia';

vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: null,
    settings: { isLoading: false },
    isCurrent: () => true,
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    backgroundTasks: {
      onTaskPage: {
        subscribe: (_: unknown, handler: { onData(id: string): void }) => {
          handler.onData('media-preview-page');
          return { unsubscribe() {} };
        },
      },
    },
  },
  trpc: {
    useUtils: () => ({}),
    account: {
      getGroupAlbumAccessState: { useQuery: () => ({ data: undefined }) },
      ocrCacheLookup: { useQuery: () => ({ data: undefined }) },
      ocrChatImage: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await vi.dynamicImportSettled();
  });
  await act(async () => {
    root.unmount();
    await vi.dynamicImportSettled();
  });
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(data: Record<string, unknown>) {
  await act(async () => {
    root.render(h(Fragment, null, h(QqImage, { data, sendTimeMs: 1000 }), h(MediaPreviewHost)));
    await vi.dynamicImportSettled();
  });
}
function preview() {
  return document.querySelector<HTMLImageElement>('.weq-lightbox-image')!;
}
function attachment(url: string): ComposerAttachment {
  const file = new File(['fixture'], 'image.png', { type: 'image/png' });
  return { id: url, kind: 'image', name: file.name, size: file.size, mime: file.type, url, file };
}

it('上传未完成时直接打开本地 Blob，不等待本机路径或服务端资源就绪', async () => {
  await mount({
    fileName: 'image.png',
    localPath: '/synthetic/not-trusted/image.png',
    localPreviewUrl: 'blob:pending-image',
  });
  expect(host.querySelector('img')!.src).toBe('blob:pending-image');
  await act(async () => {
    host.querySelector('img')!.click();
    await vi.dynamicImportSettled();
  });
  expect(preview().src).toBe('blob:pending-image');
});

it('原图尚未就绪时回退到气泡缩略图', async () => {
  await mount({ fileName: 'image.png', fileToken: 'synthetic-token' });
  await act(async () => {
    host.querySelector('img')!.click();
    await vi.dynamicImportSettled();
  });
  const cached = new URL(preview().src).searchParams;
  expect(cached.get('v')).toBe('original');
  expect(cached.get('localOnly')).toBe('1');
  await act(async () => {
    preview().dispatchEvent(new Event('error'));
    await vi.dynamicImportSettled();
  });
  const thumbnail = preview().src;
  const params = new URL(thumbnail).searchParams;
  expect(params.get('v')).toBe('thumb');
  expect(params.get('token')).toBe('synthetic-token');
  await act(async () => {
    preview().dispatchEvent(new Event('load'));
    await vi.dynamicImportSettled();
  });
  expect(preview().src).toBe(thumbnail);
});

it('缩略图在点击过程中失败，保留原按钮和独立的原图预览', async () => {
  await mount({
    fileName: 'image.png',
    fileToken: 'slow-thumbnail',
    imgWidth: 200,
    imgHeight: 100,
  });
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="查看图片：image.png"]')!;
  trigger.focus();
  act(() => host.querySelector('img')!.dispatchEvent(new Event('error')));
  act(() => host.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(trigger.isConnected).toBe(true);
  expect(document.activeElement).toBe(trigger);
  await act(async () => {
    trigger.click();
    await vi.dynamicImportSettled();
  });
  const source = new URL(preview().src);
  expect(source.searchParams.get('token')).toBe('slow-thumbnail');
  expect(source.searchParams.get('intent')).toBe('interactive');
  expect(source.searchParams.get('v')).toBe('original');
  expect(source.searchParams.get('localOnly')).toBe('1');
});

it('发送完成或切换会话释放附件时，已打开的预览保留 Blob 到关闭', async () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await mount({ fileName: 'image.png', localPreviewUrl: 'blob:pending-image' });
  await act(async () => {
    host.querySelector('img')!.click();
    await vi.dynamicImportSettled();
  });
  releaseAttachment(attachment('blob:pending-image'));
  expect(revoke).not.toHaveBeenCalled();
  expect(preview().src).toBe('blob:pending-image');
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await vi.dynamicImportSettled();
  });
  expect(revoke.mock.calls).toEqual([['blob:pending-image']]);
});

it('重复打开不会多占引用，换图后释放旧预览但不释放仍属于附件的地址', async () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await mount({ localPreviewUrl: 'blob:pending-image' });
  await act(async () => {
    host.querySelector('img')!.click();
    await vi.dynamicImportSettled();
  });
  await act(async () => {
    host.querySelector('img')!.click();
    await vi.dynamicImportSettled();
  });
  releaseAttachment(attachment('blob:pending-image'));
  await act(async () => {
    openMediaPreview({
      items: [{ key: 'blob:next-image', kind: 'image', src: 'blob:next-image' }],
    });
    await vi.dynamicImportSettled();
  });
  expect(revoke.mock.calls).toEqual([['blob:pending-image']]);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await vi.dynamicImportSettled();
  });
  expect(revoke).not.toHaveBeenCalledWith('blob:next-image');
  releaseAttachment(attachment('blob:next-image'));
  expect(revoke).toHaveBeenCalledWith('blob:next-image');
});

it('尚未加载的本机路径失败后灯箱独立回退，不要求气泡先收到失败事件', async () => {
  await mount({ fileName: 'image.png', localPath: '/synthetic/pending/image.png' });
  await act(async () => {
    host.querySelector('img')!.click();
    await vi.dynamicImportSettled();
  });
  expect(preview().src).toContain('localfile');
  await act(async () => {
    preview().dispatchEvent(new Event('error'));
    await vi.dynamicImportSettled();
  });
  expect(new URL(preview().src).hostname).toBe('pic');
  expect(new URL(preview().src).searchParams.has('v')).toBe(false);
  await act(async () => {
    preview().dispatchEvent(new Event('error'));
    await vi.dynamicImportSettled();
  });
  expect(new URL(preview().src).searchParams.get('v')).toBe('thumb');
});

it('占位图片失败后换成真实消息时重新取图，不继承旧的缺图状态', async () => {
  await mount({ fileName: 'image.png', localPreviewUrl: 'blob:expired-preview' });
  for (let index = 0; index < 3; index++) {
    await act(async () => {
      host.querySelector('img')!.dispatchEvent(new Event('error'));
      await vi.dynamicImportSettled();
    });
  }
  expect(host.querySelector('.qq-media-missing')?.getAttribute('aria-label')).toBe('未找到该图片');
  await mount({ fileName: 'image.png', fileToken: 'ready-token' });
  expect(host.querySelector('.qq-media-missing')).toBeNull();
  expect(new URL(host.querySelector('img')!.src).searchParams.get('token')).toBe('ready-token');
});

it('预览根组件卸载时归还待释放的 Blob，不留下资源引用', async () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await mount({ localPreviewUrl: 'blob:unmount-image' });
  await act(async () => {
    host.querySelector('img')!.click();
    await vi.dynamicImportSettled();
  });
  releaseAttachment(attachment('blob:unmount-image'));
  await act(async () => {
    root.render(null);
    await vi.dynamicImportSettled();
  });
  expect(revoke.mock.calls).toEqual([['blob:unmount-image']]);
});
