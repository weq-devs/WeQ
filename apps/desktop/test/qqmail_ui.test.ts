// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { MailDetail } from '@weq/service/mail';
import {
  draftFromMail,
  inlineMailImages,
  mailBodyFragment,
  mailDocument,
  mailExternalLink,
  parseMailRecipients,
  sanitizeMailEditorHtml,
  textMailHtml,
} from '../src/renderer/src/views/mail/content';

const detail: MailDetail = {
  id: 'fixture',
  folderId: 1,
  messageId: '',
  subject: '主题',
  snippet: '',
  sender: { name: '发件人', email: 'sender@example.invalid' },
  to: [
    { name: '', email: 'self@example.invalid' },
    { name: '', email: 'other@example.invalid' },
  ],
  cc: [
    { name: '', email: 'other@example.invalid' },
    { name: '', email: 'cc@example.invalid' },
  ],
  bcc: [],
  time: 1,
  size: 10,
  unread: false,
  starred: false,
  hasAttachments: true,
  draft: false,
  html: '<p>正文</p>',
  replyTo: null,
  attachments: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'a.txt',
      size: 10,
      big: false,
      available: true,
    },
  ],
};

describe('原生邮箱界面逻辑', () => {
  it('收件人去重并保留名字，拒绝无效地址与头注入', () => {
    expect(
      parseMailRecipients('小林 <a@example.invalid>, a@example.invalid; b@example.invalid'),
    ).toEqual([
      { name: '小林', email: 'a@example.invalid' },
      { name: '', email: 'b@example.invalid' },
    ]);
    expect(() => parseMailRecipients('a@example.invalid\nBcc:evil@example.invalid')).toThrow(
      '有效',
    );
    expect(() => parseMailRecipients('invalid')).toThrow('有效');
  });
  it('回复全部排除自己和重复收件人，转发引用附件而不复制凭据', () => {
    const reply = draftFromMail(detail, 'all', 'self@example.invalid');
    expect(reply.to).toBe('sender@example.invalid, other@example.invalid');
    expect(reply.cc).toBe('cc@example.invalid');
    expect(reply.replyId).toBe(detail.id);
    expect(reply.attachments).toEqual([]);
    const forward = draftFromMail(detail, 'forward', 'self@example.invalid');
    expect(forward.forwardId).toBe(detail.id);
    expect(forward.attachments).toEqual(detail.attachments);
    expect(forward.content).toContain('blockquote');
  });
  it('文本转富文本不会把尖括号当成标签，编辑器净化移除活动内容', () => {
    expect(textMailHtml('<script>test</script>\nnext')).toBe(
      '&lt;script&gt;test&lt;/script&gt;<br>next',
    );
    const html = sanitizeMailEditorHtml(
      '<b>正文</b><script>window.attack=1</script><a href="javascript:alert(1)">链接</a><img src="https://tracker.invalid">',
    );
    expect(html).toContain('<b>正文</b>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
  });
  it('正文默认阻断图片，保留不透明图片令牌并隔离脚本和表单', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const input = `<img src="https://tracker.invalid/a" data-mail-inline="${id}"><script>window.attack=1</script><form><input></form><a href="https://example.invalid" target="_top" ping="https://tracker.invalid">链接</a>`;
    const fragment = mailBodyFragment(input, false);
    expect(fragment.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(fragment.querySelector('script,form,input')).toBeNull();
    expect(fragment.querySelector('a')?.hasAttribute('target')).toBe(false);
    expect(fragment.querySelector('a')?.hasAttribute('ping')).toBe(false);
    expect(inlineMailImages(input)).toEqual([id]);
    const html = mailDocument(input, false, {});
    expect(html).toContain("script-src 'none'");
    expect(html).toContain('no-referrer');
    expect(html).not.toContain('src="https://tracker.invalid');
  });
  it('外部链接只接受 HTTP(S)，不允许带身份信息或脚本协议', () => {
    expect(mailExternalLink('https://example.invalid/path')).toBe('https://example.invalid/path');
    expect(mailExternalLink('javascript:alert(1)')).toBeNull();
    expect(mailExternalLink('https://user:secret@example.invalid')).toBeNull();
    expect(mailExternalLink('file:///etc/passwd')).toBeNull();
  });
});
