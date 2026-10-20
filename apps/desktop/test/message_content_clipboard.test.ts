import { afterEach, describe, expect, it } from 'vitest';
import {
  messageContentClipboard,
  messageContentText,
  selectedMessageClipboard,
} from '../src/renderer/src/lib/messageClipboard';
import { readMentionClipboard } from '../src/renderer/src/lib/mentionClipboard';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});
const elements = [
  {
    type: 'reply',
    data: {
      origElements: [
        { type: 'text', data: { textContent: '原话' } },
        { type: 'face', data: { faceId: 14, faceText: '[微笑]' } },
      ],
    },
  },
  { type: 'text', data: { textContent: '前' } },
  { type: 'face', data: { faceText: '[大笑]' } },
  { type: 'at', data: { atTargetUid: 'u_peer', textContent: '@甲' } },
  { type: 'mface', data: { faceName: '[贴纸]' } },
  { type: 'text', data: { textContent: '后' } },
];
describe('消息内容复制', () => {
  it('完整序列化引用、系统表情、提及及贴纸，纯文本与富文本内容一致', () => {
    const value = messageContentClipboard(elements, '不完整的旧摘要');
    expect(value.text).toBe('> 原话[微笑]\n前[大笑]@甲[贴纸]后');
    expect(messageContentText(elements)).toBe(value.text);
    const root = new DOMParser().parseFromString(value.html, 'text/html');
    expect(root.querySelector('blockquote')?.textContent).toBe('原话[微笑]');
    expect(root.querySelector('[data-weq-at-uid]')?.textContent).toBe('@甲');
    expect(root.body.textContent).toContain('前[大笑]@甲[贴纸]后');
    expect(readMentionClipboard(value.html)).toContainEqual(
      expect.objectContaining({ type: 'at' }),
    );
  });
  it('单独表情、仅引用和文件都不是空内容，正文回退不覆盖真实元素', () => {
    expect(messageContentText([{ type: 'face', data: { faceId: 99 } }])).toBe('[表情99]');
    expect(messageContentText([{ type: 'reply', data: { origText: '旧引用' } }])).toBe('> 旧引用');
    expect(messageContentText([{ type: 'file', data: { fileName: '文件.txt' } }])).toBe(
      '[文件] 文件.txt',
    );
    expect(messageContentText([elements[0]!], '正文')).toBe('> 原话[微笑]\n正文');
  });
  it('复制 DOM 混排时保留引用、表情替代文字、换行和 @，不带动画 SVG、按钮或任意 HTML', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="qq-reply-quote"><div>原作者</div><div>原话<img alt="[微笑]" src="weq-asset://face"></div><svg><title>跳转</title></svg></div><p>前<span role="img" aria-label="[动画表情]"><svg>内部动画</svg></span><span data-weq-at-uid="u_peer">@甲</span><img alt="[贴纸]" src="weq-media://private?token=secret">后<br>第二行<button>操作</button><script>bad()</script></p>';
    document.body.append(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    window.getSelection()!.addRange(range);
    const value = selectedMessageClipboard(host)!;
    expect(value.text).toBe('> 原作者\n> 原话[微笑]\n前[动画表情]@甲[贴纸]后\n第二行');
    expect(value.html).not.toMatch(/svg|script|button|token=secret|weq-media/);
    expect(value.html).toContain('blockquote');
    expect(value.html).toContain('data-weq-at-uid="u_peer"');
  });
  it('部分文字只复制实际选区，不扩成整条；选区越界不劫持复制', () => {
    const host = document.createElement('div');
    host.innerHTML = '前<img alt="[微笑]">后';
    document.body.append(host);
    const range = document.createRange();
    range.setStart(host.firstChild!, 0);
    range.setEnd(host, 2);
    window.getSelection()!.addRange(range);
    expect(selectedMessageClipboard(host)?.text).toBe('前[微笑]');
    const elsewhere = document.createElement('div');
    document.body.append(elsewhere);
    expect(selectedMessageClipboard(elsewhere)).toBeNull();
  });
  it('选中单独引用内部或动画节点内部时仍保留所在内容的语义', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="qq-reply-quote">引用内容</div><span role="img" aria-label="[动画表情]"><svg>动画路径</svg></span>';
    document.body.append(host);
    const range = document.createRange();
    range.selectNodeContents(host.firstElementChild!);
    window.getSelection()!.addRange(range);
    expect(selectedMessageClipboard(host)?.text).toBe('> 引用内容');
    range.selectNodeContents(host.lastElementChild!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(selectedMessageClipboard(host)?.text).toBe('[动画表情]');
  });
});
