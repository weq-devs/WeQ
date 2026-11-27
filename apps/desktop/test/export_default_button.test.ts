import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExportLightbox } from '../src/renderer/src/views/export/ExportLightbox';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: { exportCalendar: { useQuery: () => ({ data: [] }) } },
    bootstrap: { localModelResources: { useQuery: () => ({ data: undefined }) } },
  },
  client: {
    wonderfulTools: {
      captureSupport: { query: async () => ({ available: true, elevated: true }) },
    },
    account: {
      getGroupAlbumAccessState: { query: async () => ({ qqOnline: false, attachEnabled: false }) },
      onlineTranscribeStatus: { query: async () => ({ armed: false }) },
      onlineTranscribeDisarm: { mutate: async () => undefined },
    },
    bootstrap: {
      ocrModels: { query: async () => ({ models: [] }) },
      getSettings: {
        query: async () => ({
          ocr: { onlineConcurrency: 8, priority: 'local' },
          voiceTranscribe: { modelId: 'test-voice', onlineConcurrency: 3, priority: 'qq' },
        }),
      },
      voiceModels: { query: async () => [{ id: 'test-voice', downloaded: true }] },
      onOcrModelProgress: { subscribe: () => ({ unsubscribe: vi.fn() }) },
    },
  },
}));
vi.mock('../src/renderer/src/views/export/preflight', () => ({
  ocrReadiness: async () => ({ filterReady: false, localReady: true, onlineCapable: true }),
}));
afterEach(() => vi.unstubAllGlobals());

it('只导出相册隐藏说说互动，切回说说恢复原选择，HTML 说说保留强制状态', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const confirm = vi.fn();
  const render = (qzoneContent: 'posts' | 'albums', html = false) =>
    act(() =>
      root.render(
        h(ExportLightbox, {
          key: String(html),
          embedded: true,
          variant: 'qzone',
          headline: '空间导出',
          summary: '合成空间',
          qzoneContent,
          initialOptions: { qzoneInteractions: true },
          initialFormats: html ? ['html'] : ['json'],
          onClose: vi.fn(),
          onConfirm: confirm,
        }),
      ),
    );
  const interaction = () =>
    host.querySelector('[aria-label="评论与点赞"]')?.closest('.weq-exp-master');
  try {
    render('albums');
    await act(async () => {});
    expect(interaction()).toBeUndefined();
    render('posts');
    expect(interaction()?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(confirm).not.toHaveBeenCalled();
    render('posts', true);
    await act(async () => {});
    expect(interaction()?.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
    expect(interaction()?.textContent).toContain('强制开启');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each([false, true])('设为默认按钮可撤销，确认时携带对应保存意图（撤销：%s）', async (undo) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const confirm = vi.fn();
  const render = (hidden = false) =>
    act(() =>
      root.render(
        h(ExportLightbox, {
          embedded: true,
          hidden,
          variant: 'full',
          headline: '导出聊天记录',
          summary: '2 个会话',
          onEditList: vi.fn(),
          onClose: vi.fn(),
          onConfirm: confirm,
          initialOptions: {
            ocrImages: true,
            transcribeVoice: true,
            ocrConcurrency: 20,
            onlineConcurrency: 20,
          },
        }),
      ),
    );
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  try {
    render();
    await act(async () => {});
    expect(
      [...host.querySelectorAll('.weq-set-row-label')].map((node) => node.textContent),
    ).not.toContain('识别并发');
    expect(
      [...host.querySelectorAll('.weq-set-row-label')].map((node) => node.textContent),
    ).not.toContain('转录并发');
    expect(host.querySelector('.weq-model')).toBeNull();
    expect(host.textContent).toContain('识别设置');
    expect(host.textContent).not.toContain('设为此类内容的默认配置');
    expect(button('撤销')).toBeUndefined();
    act(() => button('设为默认').click());
    expect(button('设为默认').getAttribute('aria-pressed')).toBe('true');
    expect(button('撤销')).toBeDefined();
    render(true);
    render();
    expect(button('撤销')).toBeDefined();
    if (undo) act(() => button('撤销').click());
    expect(button('设为默认').getAttribute('aria-pressed')).toBe(String(!undo));
    const output = process.env.WEQ_EXPORT_LAYOUT_DIR;
    if (output) {
      mkdirSync(output, { recursive: true });
      const styles = ['index.css', 'export.css', 'workspace-tools.css', 'unified-export.css']
        .map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8'))
        .join('\n');
      writeFileSync(
        resolve(output, `export-default-${undo ? 'undo' : 'set'}.html`),
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}</style><style>body{margin:0;font-family:system-ui;background:var(--background)}*,*::before,*::after{box-sizing:border-box}.weq-export-options{height:100vh}</style><body>${host.innerHTML}</body></html>`,
      );
    }
    await act(async () => button('开始导出').click());
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        saveAsDefault: !undo,
        options: expect.objectContaining({
          ocrConcurrency: 8,
          onlineConcurrency: 3,
          ocrPriority: 'local',
          voicePriority: 'qq',
        }),
      }),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
