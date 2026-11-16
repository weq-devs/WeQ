import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  MediaPreviewHost,
  openMediaPreview,
} from '../src/renderer/src/components/mediaPreviewStore';

const fixture = vi.hoisted(() => ({ loads: vi.fn(), pending: Promise.resolve() }));
vi.mock('../src/renderer/src/components/MediaPreview', async () => {
  fixture.loads();
  await fixture.pending;
  const { createElement } = await import('react');
  return {
    MediaPreview: ({ onClose }: { onClose: () => void }) =>
      createElement('button', { onClick: onClose }, '合成媒体预览'),
  };
});

it('未打开时不加载预览器，慢模块有即时可关闭反馈，迟到结果不重开，后续打开复用代码', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let release!: () => void;
  fixture.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  try {
    await act(async () => root.render(h(MediaPreviewHost)));
    expect(fixture.loads).not.toHaveBeenCalled();
    await act(async () => {
      openMediaPreview({ items: [], onClose: close });
    });
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!.click(),
    );
    expect(close).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      await fixture.pending;
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      openMediaPreview({ items: [] });
    });
    expect(host.textContent).toContain('合成媒体预览');
    expect(fixture.loads).toHaveBeenCalledOnce();
  } finally {
    release();
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
