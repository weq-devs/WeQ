import { afterEach, describe, expect, it } from 'vitest';
import {
  messageContentClipboard,
  messageContentText,
  selectedMessageClipboard,
  messageRichClipboard,
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
  it('单条与批量的纯文本、富文本卡片复制保留类型与基础信息，不暴露资源票据', () => {
    const card = {
      type: 'ark',
      data: {
        arkData: JSON.stringify({
          app: 'com.tencent.miniapp.lua',
          prompt: '[小程序]',
          meta: {
            detail_1: {
              title: '合成小程序',
              desc: '基础描述',
              source: '合成来源',
              qqdocurl: 'https://example.invalid/shared',
              preview: 'https://example.invalid/private-image?token=synthetic-secret',
            },
          },
          config: { token: 'synthetic-private-token' },
        }),
      },
    };
    const single = messageContentClipboard([card]);
    expect(single.text).toContain('[小程序卡片]');
    expect(single.text).toContain('合成小程序');
    expect(single.text).toContain('基础描述');
    expect(single.text).toContain('https://example.invalid/shared');
    expect(single.text).not.toMatch(/synthetic-secret|synthetic-private-token|arkData/);
    const rich = messageRichClipboard([
      { sender: '合成用户', time: '2026-10-22T05:00:00+08:00', body: '[卡片]', elements: [card] },
    ]);
    expect(rich.text).toContain(single.text);
    expect(new DOMParser().parseFromString(rich.html, 'text/html').body.textContent).toContain(
      '合成小程序',
    );
  });

  it.each([
    {
      app: 'com.tencent.music.lua',
      meta: { music: { title: '合成歌曲', desc: '合成歌手' } },
      kind: '音乐卡片',
      text: '合成歌曲',
    },
    {
      app: 'com.tencent.troopsharecard',
      meta: { contact: { title: '合成群', id: '123456', type: 'group' } },
      kind: '群名片',
      text: '123456',
    },
    {
      app: 'com.tencent.template.public',
      meta: { mail: { title: '合成发件人', subTitle: '合成主题', content: '合成正文' } },
      kind: '邮箱通知卡片',
      text: '合成主题',
    },
    {
      app: 'custom.example',
      meta: { card: { title: '未知卡片的可读标题' } },
      kind: 'custom.example',
      text: '未知卡片的可读标题',
    },
  ])('$app 保留可辨别的卡片类型与已知字段', ({ app, meta, kind, text }) => {
    const value = messageContentText([{ type: 'ark', data: { arkData: { app, meta } } }]);
    expect(value).toContain(kind);
    expect(value).toContain(text);
    expect(value).not.toBe('[卡片]');
  });

  it('损坏卡片不会中断复制，仍保留类型和可用摘要；HTML 只放转义后的文本', () => {
    expect(
      messageContentText([{ type: 'ark', data: { arkData: 'broken', summary: '可用摘要' } }]),
    ).toContain('可用摘要');
    const value = messageContentClipboard([
      {
        type: 'ark',
        data: {
          arkData: {
            app: 'custom.example',
            meta: { card: { title: '<script>synthetic()</script>' } },
          },
        },
      },
    ]);
    expect(value.text).toContain('<script>synthetic()</script>');
    expect(
      new DOMParser().parseFromString(value.html, 'text/html').querySelector('script'),
    ).toBeNull();
  });
  it('位置、动态、Markdown 与编码公告保留可读字段，不重复附带的兼容文本', () => {
    const announcement = {
      type: 'ark',
      data: {
        arkData: {
          app: 'com.tencent.mannounce',
          meta: { announce: { encode: 1, title: btoa('Notice'), text: btoa('Visible content') } },
        },
      },
    };
    expect(messageContentText([announcement])).toContain('[群公告]\nNotice\nVisible content');
    expect(
      messageContentText([{ type: 'shareLocation', data: { shareLocationText: '合成地点' } }]),
    ).toContain('[位置卡片]\n合成地点');
    expect(
      messageContentText([
        { type: 'qqDynamic', data: { dynamicDesc: { mainDesc: '合成动态', subDesc: '基础信息' } } },
      ]),
    ).toContain('[QQ 动态卡片]\n合成动态\n基础信息');
    const markdown = [
      { type: 'markdown', data: { markdownContent: '合成正文' } },
      { type: 'text', data: { textContent: '合成正文' } },
    ];
    expect(messageContentText(markdown)).toBe('[Markdown 卡片]\n合成正文');
    expect(
      new DOMParser().parseFromString(messageContentClipboard(markdown).html, 'text/html').body
        .textContent,
    ).toBe('[Markdown 卡片]\n合成正文');
    expect(
      messageContentText([
        {
          type: 'ark',
          data: { arkData: { app: '__proto__', meta: { card: { title: '安全回退' } } } },
        },
      ]),
    ).toContain('安全回退');
  });
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
