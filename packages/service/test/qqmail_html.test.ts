import { describe, expect, it } from 'vitest';
import { MailAuth } from '../src/account/mail/auth';
import { MailAttachmentRegistry } from '../src/account/mail/attachments';
import { protectMailHtml } from '../src/account/mail/html';

describe('邮箱 HTML 凭据边界', () => {
  it('主进程将带会话的内嵌图片换成令牌，HTML中不返回私有URL', () => {
    const registry = new MailAttachmentRegistry();
    const html = protectMailHtml(
      '<img src="https://wx.mail.qq.com/attach/viewfile?sid=fixture-secret&amp;fileid=f" srcset="https://wx.mail.qq.com/attach/a?sid=fixture-secret"><a href="https://wx.mail.qq.com/read/readmail?sid=fixture-secret&amp;mailid=m">邮件</a>',
      registry,
    );
    expect(html).not.toContain('fixture-secret');
    expect(html).not.toContain('srcset');
    const id = /data-mail-inline="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(registry.imageUrl(id!).searchParams.get('sid')).toBe('fixture-secret');
    registry.clear();
    expect(() => registry.imageUrl(id!)).toThrow('已失效');
  });
  it('容错解析普通 HTML，并不改写公开外部图片为邮箱资源', () => {
    const registry = new MailAttachmentRegistry();
    const html = protectMailHtml(
      '<p>正文<img src="https://public.example.invalid/p.png"><p>下一段',
      registry,
    );
    expect(html).toContain('public.example.invalid');
    expect(html).not.toContain('data-mail-inline');
  });
  it('票据文本和百分号编码值也会在跨IPC前脱敏', async () => {
    const auth = new MailAuth(
      {
        ptFetchMailSession: async () => ({
          success: false,
          msg: '离线',
          sid: '',
          panelPskey: '',
          cookie: '',
          errorKind: 'offline',
        }),
      },
      '12345678',
      () => null,
    );
    await auth.transport.jar.setCookie(
      'p_skey=fixture+private/key; Domain=mail.qq.com; Path=/; Secure',
      'https://wx.mail.qq.com/',
    );
    const safe = await auth.redact(
      '<p>fixture+private/key</p><span data-key="fixture%2Bprivate%2Fkey"></span>',
    );
    expect(safe).not.toContain('fixture+private/key');
    expect(safe).not.toContain('fixture%2Bprivate%2Fkey');
    expect(safe).toContain('[redacted]');
    auth.dispose();
  });
});
