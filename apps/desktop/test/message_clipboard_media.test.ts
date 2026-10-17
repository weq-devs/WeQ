import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageRichClipboard } from '../src/renderer/src/lib/messageClipboard';
import { repeatImageSources, repeatSendPlan } from '../src/renderer/src/lib/messageRepeat';
import { exportMedia } from '../src/renderer/src/lib/mediaExport';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('消息富文本及图片', () => {
  it('发送者、时间、正文与引用保持轻量结构，HTML 输入不能注入元素', () => {
    const result = messageRichClipboard([
      {
        sender: '<script>姓名</script>',
        time: '2026-10-17',
        body: '正文\n第二行',
        elements: [
          {
            type: 'reply',
            data: { origElements: [{ type: 'text', data: { textContent: '原话' } }] },
          },
        ],
      },
    ]);
    const root = new DOMParser().parseFromString(result.html, 'text/html');
    expect(root.querySelector('strong')?.textContent).toBe('<script>姓名</script>');
    expect(root.querySelector('small')?.textContent).toContain('2026-10-17');
    expect(root.querySelector('blockquote')?.textContent).toBe('原话');
    expect(root.querySelector('script')).toBeNull();
    expect(result.text).toContain('正文\n第二行');
  });
  it('富文本保留 @ 的唯一身份', () => {
    const result = messageRichClipboard([
      {
        sender: '甲',
        time: '',
        body: '@旧名',
        elements: [{ type: 'at', data: { atTargetUid: 'u_test', textContent: '@旧名' } }],
      },
    ]);
    expect(result.html).toContain('data-weq-at-uid="u_test"');
  });
  it('普通渲染图片只有 MD5、没有 SHA1 时也可取原图并重发', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const element = {
      type: 'pic',
      data: { md5: 'a'.repeat(32), fileName: 'fixture.png', fileToken: 'token', subType: 1 },
    };
    const images = await repeatImageSources([element], 123);
    const plan = repeatSendPlan([element], new Map(), true, images);
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(plan).toMatchObject({
      kind: 'elements',
      elements: [{ kind: 'image', source: new Uint8Array([137, 80, 78, 71]), subType: 1 }],
    });
  });
  it('图像不可用时失败，不重发 [图片] 占位', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    await expect(
      repeatImageSources([{ type: 'pic', data: { fileName: 'missing.png' } }], 0),
    ).rejects.toThrow('不可用');
  });
  it('桌面复制图像走原生位图接口', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { ipcRenderer: { invoke } },
    });
    expect(await exportMedia({ url: 'weq-media://pic?name=fixture.png' }, 'clipboard')).toEqual({
      ok: true,
    });
    expect(invoke).toHaveBeenCalledWith(
      'media:export',
      expect.objectContaining({ mode: 'clipboard' }),
    );
    Object.defineProperty(window, 'electron', { configurable: true, value: undefined });
  });
  it('Web 不支持图片剪贴板时如实报错，不覆盖成文本', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await exportMedia({ url: '/media/pic?name=fixture.png' }, 'clipboard');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不支持');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
