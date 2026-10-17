import { describe, expect, it } from 'vitest';
import { qzoneReplyPresentation } from '../src/renderer/src/lib/qzoneReplyPresentation';

const reply = (content: string) => ({ isReply: true, content });
describe('Qzone reply recipient presentation', () => {
  it('moves an exact known recipient before the colon without an @', () => {
    expect(
      qzoneReplyPresentation({ ...reply('@{uin:10001,nick:被回复人} 正文'), replyToUin: '10001' }),
    ).toMatchObject({
      content: '正文',
      replyToUin: '10001',
      replyToNickname: '被回复人',
    });
  });
  it('recognizes the exact parent identity when older data omitted recipient metadata', () => {
    expect(qzoneReplyPresentation(reply('@{uin:10001,nick:被回复人} 正文'), '10001')).toMatchObject(
      {
        content: '正文',
        replyToUin: '10001',
        replyToNickname: '被回复人',
      },
    );
  });
  it('recognizes an explicit automatic recipient even when replying to another reply', () => {
    expect(
      qzoneReplyPresentation(reply('@{uin:10003,nick:另一位,who:1} 回复正文'), '10001'),
    ).toMatchObject({
      content: '回复正文',
      replyToUin: '10003',
      replyToNickname: '另一位',
    });
  });
  it('keeps authored mentions in the body and does not rewrite the source', () => {
    const original = reply('@{uin:10001,nick:被回复人,who:1} @{uin:10002,nick:真正提及} 正文');
    expect(qzoneReplyPresentation(original).content).toBe('@{uin:10002,nick:真正提及} 正文');
    expect(original.content).toContain('被回复人,who:1');
  });
  it('does not guess unrelated leading mentions or override conflicting recipient metadata', () => {
    const authored = reply('@{uin:10003,nick:真正提及} 正文');
    expect(qzoneReplyPresentation(authored, '10001')).toBe(authored);
    const conflict = { ...reply('@{uin:10003,nick:其他人,who:1} 正文'), replyToUin: '10001' };
    expect(qzoneReplyPresentation(conflict, '10001')).toBe(conflict);
  });
  it('leaves root comments and plain-text @ names alone', () => {
    const root = { isReply: false, content: '@{uin:10001,nick:用户,who:1} 评论正文' };
    expect(qzoneReplyPresentation(root, '10001')).toBe(root);
    const plain = reply('@同名用户 正文');
    expect(qzoneReplyPresentation(plain, '10001')).toBe(plain);
  });
});
