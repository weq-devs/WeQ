import { describe, expect, it, vi } from 'vitest';
import { MailAuth } from '../src/account/mail/auth';
import { MailAttachmentRegistry } from '../src/account/mail/attachments';
import { loadMailInlineImage } from '../src/account/mail/files';
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
  it('公开外部图片使用独立于邮箱凭据的加载令牌，同一地址只登记一次', () => {
    const registry = new MailAttachmentRegistry();
    const html = protectMailHtml(
      '<p>正文<img src="https://public.example.invalid/p.png"><p>下一段<img src="https://public.example.invalid/p.png">',
      registry,
    );
    const ids = [...html.matchAll(/data-mail-inline="([^"]+)"/g)].map((match) => match[1]!);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(registry.imageUrl(ids[0]!).href).toBe('https://public.example.invalid/p.png');
    expect(html).not.toContain('public.example.invalid');
  });
  it('外链图不读取邮箱凭据，并拒绝本机地址', async () => {
    const registry = new MailAttachmentRegistry();
    const id = registry.registerImage(new URL('https://127.0.0.1/image.png'));
    const auth = { downloadCredentials: vi.fn() } as unknown as MailAuth;
    await expect(
      loadMailInlineImage(auth, registry, id, new AbortController().signal),
    ).rejects.toThrow('邮箱图片暂时无法加载');
    expect(auth.downloadCredentials).not.toHaveBeenCalled();
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
