import { act, createElement as h, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { ImageLightbox, openLightbox } from '../src/renderer/src/components/ImageLightbox';
import { VideoLightbox, openVideoLightbox } from '../src/renderer/src/components/VideoLightbox';
import { QqImage, QqVideo, QqVoice, QqMarketFace } from '../src/renderer/src/components/QqMedia';
import { mediaRetryUrl } from '../src/renderer/src/lib/mediaRetryUrl';

vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: null,
    settings: { isLoading: false },
    isCurrent: () => true,
  }),
}));
vi.mock('../src/renderer/src/hooks/useVoiceTranscription', () => ({
  useVoiceTranscription: () => ({ available: false }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getGroupAlbumAccessState: { useQuery: () => ({ data: undefined }) },
      ocrCacheLookup: { useQuery: () => ({ data: undefined }) },
      ocrChatImage: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() =>
    document.querySelectorAll<HTMLButtonElement>('.weq-lightbox-close').forEach((el) => {
      el.click();
    }),
  );
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (label: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (el) => el.getAttribute('aria-label') === label || el.textContent === label,
  );
  if (!found) throw new Error(`缺少按钮：${label}`);
  return found;
};
const image = () => document.querySelector<HTMLImageElement>('.weq-lightbox-image')!;
const send = (target: EventTarget, name: string) =>
  act(() => target.dispatchEvent(new Event(name, { bubbles: false })));
const key = (name: string) =>
  act(() =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    ),
  );

it('可操作图片、闪照、语音、视频及商城表情使用原生按钮，动画表情不伪装成按钮', () => {
  act(() =>
    root.render(
      h(
        Fragment,
        null,
        h(QqImage, { data: { fileName: 'photo.png' }, sendTimeMs: 1 }),
        h(QqImage, { data: { fileToken: '/123-456-ABC', isFlash: true }, sendTimeMs: 1 }),
        h(QqImage, { data: { subType: 1 }, sendTimeMs: 1 }),
        h(QqVoice, { data: {}, sendTimeMs: 1 }),
        h(QqVideo, { data: {}, sendTimeMs: 1 }),
        h(QqMarketFace, { data: { emojiPackId: 1, marketEmoticonIdHex: 'abc' } }),
      ),
    ),
  );
  for (const selector of [
    '.qq-media-wrap:not(.qq-media-wrap-emoji)',
    '.qq-flash-cover',
    '.qq-media-voice',
    '.qq-media-video',
    '.qq-mface-wrap',
  ]) {
    const control = host.querySelector(selector)!;
    expect(control.tagName).toBe('BUTTON');
    expect(control.getAttribute('aria-label')).toBeTruthy();
    expect(control.querySelector('button')).toBeNull();
  }
  expect(host.querySelector('.qq-media-wrap-emoji')!.tagName).toBe('SPAN');
});

it('图片候选全部失败才显示终态，重试从原始候选重新进入同一媒体链并忽略迟到事件', () => {
  act(() => root.render(h(ImageLightbox)));
  act(() =>
    openLightbox('weq-media://pic?token=fixture', '图片', null, document, undefined, [
      'weq-media://pic?token=fixture&v=thumb',
    ]),
  );
  expect(document.querySelector('[role="status"]')?.textContent).toContain('正在加载图片');
  expect(button('复制到剪贴板').disabled).toBe(true);
  const original = image();
  send(original, 'error');
  expect(image().src).toContain('v=thumb');
  expect(document.querySelector('.weq-media-load-error')).toBeNull();
  send(image(), 'error');
  expect(document.querySelector('.weq-media-load-error')?.textContent).toContain(
    '图片暂时无法加载',
  );
  act(() => button('重试加载图片').click());
  expect(image().src).toContain('token=fixture');
  expect(image().src).not.toContain('v=thumb');
  expect(image().src).not.toBe(original.src);
  send(original, 'load');
  expect(button('复制到剪贴板').disabled).toBe(true);
  send(image(), 'load');
  expect(document.querySelector('.weq-media-load-error')).toBeNull();
  expect(button('复制到剪贴板').disabled).toBe(false);
});

it('媒体按键不被消息行的 Enter 和方向键导航截走，同时保留原生默认动作', () => {
  const navigate = vi.fn();
  act(() =>
    root.render(
      h(
        'div',
        { onKeyDown: navigate },
        h(QqImage, { data: {}, sendTimeMs: 1 }),
        h(QqVoice, { data: {}, sendTimeMs: 1 }),
      ),
    ),
  );
  for (const control of host.querySelectorAll<HTMLButtonElement>('.qq-media-action')) {
    for (const name of ['Enter', ' ', 'ArrowDown']) {
      const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
      act(() => control.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
  }
  expect(navigate).not.toHaveBeenCalled();
});

it('引用定位缩略图不再叠加媒体按钮或失败重试入口', () => {
  act(() =>
    root.render(
      h(
        Fragment,
        null,
        h(QqImage, { data: {}, sendTimeMs: 1, interactive: false }),
        h(QqVideo, { data: {}, sendTimeMs: 1, interactive: false }),
        h(QqMarketFace, {
          data: { emojiPackId: 1, marketEmoticonIdHex: 'abc' },
          interactive: false,
        }),
      ),
    ),
  );
  expect(host.querySelector('button')).toBeNull();
  for (let i = 0; i < 2; i++) send(host.querySelector('.qq-media-wrap img')!, 'error');
  expect(host.querySelector('.qq-media-retry')).toBeNull();
});

it('预览焦点进入、Tab回环、键盘缩放、关闭后归还触发点', () => {
  act(() =>
    root.render(
      h(
        Fragment,
        null,
        h('button', { onClick: () => openLightbox('data:image/png;base64,fixture') }, '打开图片'),
        h(ImageLightbox),
      ),
    ),
  );
  const trigger = button('打开图片');
  trigger.focus();
  act(() => trigger.click());
  const layer = document.querySelector<HTMLElement>('.weq-lightbox-layer')!;
  expect(layer.contains(document.activeElement)).toBe(true);
  send(image(), 'load');
  key('+');
  expect(document.querySelector<HTMLElement>('.weq-lightbox-frame')!.style.transform).toContain(
    'scale(1.25)',
  );
  key('0');
  expect(document.querySelector<HTMLElement>('.weq-lightbox-frame')!.style.transform).toContain(
    'scale(1)',
  );
  const enabled = [...layer.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  enabled.at(-1)!.focus();
  key('Tab');
  expect(document.activeElement).toBe(enabled[0]);
  key('Escape');
  expect(document.querySelector('.weq-lightbox-layer')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('上层表面存在时 Escape 不关闭下层预览', () => {
  act(() => root.render(h(ImageLightbox)));
  act(() => openLightbox('data:image/png;base64,fixture'));
  const upper = document.createElement('div');
  upper.setAttribute('role', 'dialog');
  upper.style.zIndex = '99999';
  document.body.append(upper);
  try {
    key('Escape');
    expect(image()).not.toBeNull();
  } finally {
    upper.remove();
  }
});

it('已打开预览迁移到子窗口后，焦点和 Escape 跟随所属文档', () => {
  const child = new HappyWindow();
  act(() => root.render(h(Fragment, null, h('button', null, '主窗入口'), h(ImageLightbox))));
  const trigger = button('主窗入口');
  trigger.focus();
  act(() => openLightbox('data:image/png;base64,main'));
  const childTrigger = child.document.createElement('button');
  child.document.body.append(childTrigger);
  childTrigger.focus();
  try {
    act(() =>
      openLightbox('data:image/png;base64,child', '', null, child.document as unknown as Document),
    );
    expect(document.activeElement).toBe(trigger);
    expect(
      child.document.querySelector('.weq-lightbox-layer')?.contains(child.document.activeElement),
    ).toBe(true);
    act(() =>
      child.document.activeElement?.dispatchEvent(
        new child.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    expect(child.document.querySelector('.weq-lightbox-layer')).toBeNull();
    expect(child.document.activeElement).toBe(childTrigger);
  } finally {
    child.close();
  }
});

it('视频预览具有模态语义、失败提示、重试及焦点归还', () => {
  act(() =>
    root.render(
      h(
        Fragment,
        null,
        h(
          'button',
          { onClick: () => openVideoLightbox('weq-media://localmedia?kind=video&rel=fixture.mp4') },
          '打开视频',
        ),
        h(VideoLightbox),
      ),
    ),
  );
  const trigger = button('打开视频');
  trigger.focus();
  act(() => trigger.click());
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')!;
  expect(dialog.contains(document.activeElement)).toBe(true);
  const video = document.querySelector('video')!;
  send(video, 'error');
  expect(document.querySelector('.weq-media-load-error')?.textContent).toContain(
    '视频暂时无法播放',
  );
  act(() => button('重试加载视频').click());
  const next = document.querySelector('video')!;
  expect(next).not.toBe(video);
  expect(next.src).not.toBe(video.src);
  send(next, 'canplay');
  expect(document.querySelector('.weq-media-load-error')).toBeNull();
  key('Escape');
  expect(document.activeElement).toBe(trigger);
});

it('聊天视频从封面开始播放或失败重试后聚焦原生播放器', () => {
  act(() => root.render(h(QqVideo, { data: {}, sendTimeMs: 1 })));
  act(() => button('播放视频').click());
  expect(document.activeElement).toBe(host.querySelector('video'));
  send(host.querySelector('video')!, 'error');
  act(() => button('重试加载视频').click());
  expect(document.activeElement).toBe(host.querySelector('video'));
});

it('聊天图片最终失败后可重新加载，不改变媒体占位尺寸', () => {
  act(() => root.render(h(QqImage, { data: { imgWidth: 200, imgHeight: 100 }, sendTimeMs: 1 })));
  for (let i = 0; i < 2; i++) send(host.querySelector('img')!, 'error');
  const missing = host.querySelector<HTMLElement>('.qq-media-missing')!;
  expect(missing.style.width).toBe('200px');
  act(() => button('重试加载图片').click());
  expect(host.querySelector('img')).not.toBeNull();
  expect(host.querySelector<HTMLElement>('img')!.style.width).toBe('200px');
});

it('重试仅刷新媒体桥，保留定位参数，不改写 CDN 签名与 Blob/Data 地址', () => {
  for (const source of [
    'weq-media://pic?token=a&orig=%2Fphoto',
    '/_media/video?msgId=42&fwdKind=group',
    'https://local.test/_media/pic?token=a',
  ]) {
    const url = new URL(mediaRetryUrl(source, 2), 'http://fixture');
    expect(url.searchParams.get('_weq_retry')).toBe('2');
    const original = new URL(source, 'http://fixture');
    for (const [key, value] of original.searchParams) expect(url.searchParams.get(key)).toBe(value);
  }
  for (const source of [
    'https://cdn.test/download?signature=keep%2Bme',
    'blob:fixture',
    'data:image/png;base64,fixture',
  ])
    expect(mediaRetryUrl(source, 1)).toBe(source);
});

it('触屏平移在取消、第二指针或窗口失焦后可继续，不把中断误当点击缩放', () => {
  act(() => root.render(h(ImageLightbox)));
  act(() => openLightbox('data:image/png;base64,fixture'));
  send(image(), 'load');
  act(() => button('放大').click());
  const frame = document.querySelector<HTMLElement>('.weq-lightbox-frame')!;
  const pointer = (target: EventTarget, name: string, id: number, x: number, primary = true) =>
    act(() =>
      target.dispatchEvent(
        new PointerEvent(name, {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          pointerType: 'touch',
          isPrimary: primary,
          clientX: x,
          clientY: 10,
        }),
      ),
    );
  pointer(frame, 'pointerdown', 1, 10);
  pointer(window, 'pointermove', 1, 30);
  expect(frame.style.transform).toContain('20px');
  pointer(window, 'pointercancel', 1, 30);
  pointer(window, 'pointermove', 1, 100);
  expect(frame.style.transform).toContain('20px');
  pointer(frame, 'pointerdown', 2, 10);
  pointer(frame, 'pointerdown', 3, 10, false);
  pointer(window, 'pointermove', 2, 100);
  expect(frame.style.transform).toContain('20px');
  pointer(frame, 'pointerdown', 4, 10);
  send(window, 'blur');
  pointer(window, 'pointermove', 4, 100);
  expect(frame.style.transform).toContain('20px');
  pointer(frame, 'pointerdown', 5, 10);
  pointer(window, 'pointermove', 5, 40);
  pointer(window, 'pointerup', 5, 40);
  expect(frame.style.transform).toContain('50px');
  expect(frame.style.transform).toContain('scale(1.25)');
});

it('语音播放失败可用同一按钮重试，卸载后不继续播放', async () => {
  const play = vi
    .spyOn(HTMLMediaElement.prototype, 'play')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue();
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  act(() => root.render(h(QqVoice, { data: { fileToken: 'voice' }, sendTimeMs: 1 })));
  await act(async () => button('播放语音').click());
  expect(document.querySelector('[role="status"]')?.textContent).toContain('语音暂时无法播放');
  await act(async () => button('重试播放语音').click());
  expect(play).toHaveBeenCalledTimes(2);
  expect(button('暂停语音').getAttribute('aria-pressed')).toBe('true');
  act(() => root.render(null));
  expect(pause).toHaveBeenCalled();
});
