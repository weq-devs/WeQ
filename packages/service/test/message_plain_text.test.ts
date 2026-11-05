import { describe, expect, it } from 'vitest';
import {
  plainMessageText,
  plainContentText,
  plainSenderText,
} from '../src/common/message_plain_text';

describe('统一消息纯文本', () => {
  it('固定北京时间，不受机器时区影响，保留正文换行与空行', () => {
    expect(
      plainMessageText({
        name: '小明',
        uin: '123456789',
        time: new Date('2026-11-06T06:30:00Z'),
        elements: [{ type: 'text', data: { textContent: '第一行\n\n第三行' } }],
      }),
    ).toBe('小明 (123456789) · 2026-11-06 14:30:00\n第一行\n\n第三行');
  });
  it('缺失身份不输出空括号，不重复数字名称，不把 0 当 QQ 号', () => {
    expect(plainSenderText({ name: '小明' })).toBe('小明');
    expect(plainSenderText({ name: '12345', uin: '12345' })).toBe('12345');
    expect(plainSenderText({ uin: '0' })).toBe('未知发送者');
    expect(plainMessageText({ time: new Date('bad'), body: '正文' })).toBe(
      '未知发送者 · 时间未知\n正文',
    );
  });
  it('引用不截断，使用真实原发送者，不用外层发送者替代', () => {
    expect(
      plainContentText([
        {
          type: 'reply',
          data: {
            origSenderUin: 12345,
            origElements: [{ type: 'text', data: { textContent: `${'长'.repeat(50)}\n下一行` } }],
          },
        },
        { type: 'text', data: { textContent: '收到' } },
      ]),
    ).toBe(`> 12345\n> ${'长'.repeat(50)}\n> 下一行\n收到`);
  });
  it('图文按顺序换行，路径独立成行，不泄漏本地缓存路径', () => {
    expect(
      plainContentText([
        { type: 'text', data: { textContent: '看这里' } },
        {
          type: 'pic',
          data: { fileName: 'a.png', exportPath: 'media/image/a.png', localPath: '/private/cache' },
        },
        { type: 'text', data: { textContent: '后续文字' } },
        { type: 'ptt', data: { pttDuration: 5, pttTranscript: '好\n收到' } },
      ]),
    ).toBe(
      '看这里\n[图片: a.png]\n附件：media/image/a.png\n后续文字\n[语音: 5秒]\n[语音转写]\n好\n收到',
    );
  });
  it('卡片保留标题、描述、链接，但不重复兼容文本', () => {
    expect(
      plainContentText([
        {
          type: 'ark',
          data: {
            arkData: {
              app: 'com.tencent.structmsg',
              meta: {
                news: {
                  title: '校园活动',
                  desc: '本周安排',
                  jumpUrl: 'https://example.com/events',
                  preview: 'https://example.com/private?token=secret',
                },
              },
            },
          },
        },
        { type: 'text', data: { textContent: '兼容摘要' } },
      ]),
    ).toBe('[链接卡片]\n标题：校园活动\n描述：本周安排\n链接：https://example.com/events');
  });
  it('转发递归展开、缩进全部正文；循环输入有界', () => {
    const forward = {
      type: 'multiMsg',
      data: {
        forwardMessages: [
          {
            senderName: '小王',
            senderUin: '112233445',
            sendTime: 1793942400,
            elements: [{ type: 'text', data: { textContent: '第一行\n第二行' } }],
          },
        ],
      },
    };
    expect(plainContentText([forward])).toBe(
      '[聊天记录]\n  小王 (112233445) · 2026-11-06 13:20:00\n  第一行\n  第二行\n[/聊天记录]',
    );
    const cyclic: { type: string; data: Record<string, unknown> } = { type: 'reply', data: {} };
    cyclic.data.origElements = [cyclic];
    expect(plainContentText([cyclic]).length).toBeLessThan(500);
  });
});
