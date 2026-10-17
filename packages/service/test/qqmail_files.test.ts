import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createHash } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailAuth } from '../src/account/mail/auth';
import { MailAttachmentRegistry } from '../src/account/mail/attachments';
import { MAIL_PART_SIZE } from '../src/account/mail/wire';
import {
  downloadMailFile,
  encryptMailPart,
  hashMailFile,
  mailStorageUrl,
  uploadMailFile,
  type StorageRequest,
} from '../src/account/mail/files';

const roots: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'weq-mail-files-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function auth(): MailAuth {
  return new MailAuth(
    { probePtLoginPort: () => ({ success: false, port: 0, msg: '' }) },
    '12345678',
    () => null,
  );
}
function response(status: number, data = '', location?: string): IncomingMessage {
  const value = new IncomingMessage(new Socket());
  value.statusCode = status;
  value.headers = location ? { location } : {};
  value.push(Buffer.from(data));
  value.push(null);
  return value;
}

describe('邮箱附件协议', () => {
  it('5 MiB 非末片累计状态与 QQ 官方 worker 黄金夹具一致', async () => {
    const path = join(await directory(), 'fixture.bin');
    const bytes = Buffer.alloc(MAIL_PART_SIZE + 31, 0x5a);
    await writeFile(path, bytes);
    const handle = await open(path, 'r');
    try {
      const hash = await hashMailFile(handle, bytes.length, new AbortController().signal);
      expect(hash.md5).toBe(createHash('md5').update(bytes).digest('hex'));
      expect(hash.sha).toBe(createHash('sha1').update(bytes).digest('hex'));
      expect(hash.parts[0]).toEqual({
        start: 0,
        endOffset: MAIL_PART_SIZE,
        partNumber: 1,
        cumulativeSha1: '51fac85619c6a878013b912794722f35f6a2704c',
      });
      expect(hash.parts[1]!.endOffset).toBe(bytes.length);
    } finally {
      await handle.close();
    }
  });
  it('AES-CTR 分片计数器与标准实现一致，包含128位进位', () => {
    const key = Buffer.alloc(32, 0x31),
      iv = Buffer.alloc(16, 0xff),
      bytes = Buffer.alloc(32, 0x42);
    const counter = Buffer.alloc(16);
    counter[15] = 1;
    const cipher = createCipheriv('aes-256-ctr', key, counter);
    expect(encryptMailPart(bytes, { key, iv }, 32)).toEqual(
      Buffer.concat([cipher.update(bytes), cipher.final()]),
    );
    expect(() => encryptMailPart(bytes, { key: Buffer.alloc(3), iv }, 0)).toThrow('加密参数');
  });
  it('多片上传的初始化、PUT、ETag和完成确认不混入邮箱 Cookie', async () => {
    const path = join(await directory(), 'fixture.bin');
    await writeFile(path, Buffer.alloc(MAIL_PART_SIZE + 7, 0x5a));
    const account = auth(),
      registry = new MailAttachmentRegistry();
    vi.spyOn(account, 'cgi').mockImplementation(async (path) =>
      path === '/attach/get_enc_key'
        ? {}
        : {
            fileid: 'fixture-file',
            dns: 'upload.cstore.qq.com',
            upload_key: 'fixture-key',
            is_exist: false,
          },
    );
    const calls: { url: URL; method: string; length: number; json?: Record<string, unknown> }[] =
      [];
    const request: StorageRequest = async (url, method, body) => {
      calls.push({
        url,
        method,
        length: body.length,
        json:
          method === 'POST' ? (JSON.parse(body.toString()) as Record<string, unknown>) : undefined,
      });
      return { etag: `etag-${url.searchParams.get('partnumber')}` };
    };
    const attachment = await uploadMailFile(
      account,
      registry,
      path,
      new AbortController().signal,
      request,
    );
    expect(calls.map((call) => call.method)).toEqual(['POST', 'PUT', 'PUT', 'POST']);
    expect(calls[0]!.json!.partcount).toBe(2);
    expect(calls[1]!.length).toBe(MAIL_PART_SIZE);
    expect(calls[2]!.length).toBe(7);
    expect(calls[3]!.json!.parts).toEqual([
      { partnumber: 1, ETag: 'etag-1' },
      { partnumber: 2, ETag: 'etag-2' },
    ]);
    expect(JSON.stringify(attachment)).not.toContain('fixture-key');
    expect(registry.sendParams([attachment.id]).normal).toEqual([
      { name: 'fixture.bin', fileid: 'fixture-file', fw_mailid: undefined },
    ]);
    account.dispose();
  });
  it('秒传不再上传字节，取消任务不创建远程附件', async () => {
    const path = join(await directory(), 'fixture.txt');
    await writeFile(path, 'fixture');
    const account = auth(),
      registry = new MailAttachmentRegistry();
    const cgi = vi
      .spyOn(account, 'cgi')
      .mockImplementation(async (path) =>
        path === '/attach/get_enc_key' ? {} : { fileid: 'fixture-file', is_exist: true },
      );
    const request = vi.fn<StorageRequest>();
    await uploadMailFile(account, registry, path, new AbortController().signal, request);
    expect(request).not.toHaveBeenCalled();
    cgi.mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadMailFile(account, registry, path, controller.signal, request),
    ).rejects.toThrow('取消');
    expect(cgi).not.toHaveBeenCalled();
    account.dispose();
  });
  it('存储地址拒绝外域、明文、身份信息与自定义端口', () => {
    expect(mailStorageUrl('https://upload.cstore.qq.com/file').hostname).toBe(
      'upload.cstore.qq.com',
    );
    for (const value of [
      'https://qq.com.evil.invalid/file',
      'http://upload.cstore.qq.com/file',
      'https://user:password@upload.cstore.qq.com/file',
      'https://upload.cstore.qq.com:8443/file',
      'https://127.0.0.1/file',
    ])
      expect(() => mailStorageUrl(value)).toThrow('不受信任');
  });
});

describe('邮箱附件下载', () => {
  it('跨主机重定向不转发邮箱 Cookie，不覆盖目标文件', async () => {
    const root = await directory(),
      account = auth(),
      registry = new MailAttachmentRegistry();
    const attachment = registry.register({
      fileId: 'fixture',
      name: 'a.txt',
      size: 3,
      big: false,
      available: true,
    });
    vi.spyOn(account, 'downloadCredentials').mockResolvedValue({
      url: new URL('https://wx.mail.qq.com/attach/download'),
      cookie: 'fixture-cookie',
    });
    const cookies: string[] = [];
    const request = vi.fn(async (_url: URL, cookie: string) => {
      cookies.push(cookie);
      return cookies.length % 2
        ? response(302, '', 'https://download.qq.com/file')
        : response(200, 'abc');
    });
    const destination = join(root, 'saved.txt');
    await downloadMailFile(
      account,
      registry,
      attachment.id,
      destination,
      new AbortController().signal,
      request,
    );
    expect(cookies).toEqual(['fixture-cookie', '']);
    expect(await readFile(destination, 'utf8')).toBe('abc');
    await expect(
      downloadMailFile(
        account,
        registry,
        attachment.id,
        destination,
        new AbortController().signal,
        request,
      ),
    ).rejects.toThrow('可能已存在');
    expect(await readFile(destination, 'utf8')).toBe('abc');
    expect((await readdir(root)).some((name) => name.endsWith('.part'))).toBe(false);
    account.dispose();
  });
  it('外域重定向与不完整响应均不发布目标文件', async () => {
    const root = await directory(),
      account = auth(),
      registry = new MailAttachmentRegistry();
    const attachment = registry.register({
      fileId: 'fixture',
      name: 'a.txt',
      size: 3,
      big: false,
      available: true,
    });
    vi.spyOn(account, 'downloadCredentials').mockResolvedValue({
      url: new URL('https://wx.mail.qq.com/attach/download'),
      cookie: 'fixture-cookie',
    });
    const request = vi.fn(async () => response(302, '', 'https://evil.invalid/file'));
    await expect(
      downloadMailFile(
        account,
        registry,
        attachment.id,
        join(root, 'saved.txt'),
        new AbortController().signal,
        request,
      ),
    ).rejects.toThrow('不受信任');
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      downloadMailFile(
        account,
        registry,
        attachment.id,
        join(root, 'saved.txt'),
        new AbortController().signal,
        async () => response(200, 'ab'),
      ),
    ).rejects.toThrow('不完整');
    expect(await readdir(root)).toEqual([]);
    account.dispose();
  });
});
