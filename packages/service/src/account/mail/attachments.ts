import { randomUUID } from 'node:crypto';
import { MailFailure, type MailAttachment } from './types';
import {
  MAIL_ORIGIN,
  count,
  isMailDownloadHost,
  items,
  object,
  text,
  type MailObject,
} from './wire';

export interface MailAttachmentSource {
  fileId: string;
  mailId?: string;
  name: string;
  size: number;
  big: boolean;
  available: boolean;
  key?: string;
  code?: string;
  bizId?: number;
  download?: string;
}

/** 仅账号服务持有远程 key/code/签名 URL，前端使用随机附件令牌。 */
export class MailAttachmentRegistry {
  private readonly entries = new Map<string, MailAttachmentSource>();
  private readonly images = new Map<string, URL>();

  registerImage(url: URL): string {
    if (
      url.protocol !== 'https:' ||
      !isMailDownloadHost(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      throw new MailFailure('business', '邮箱图片地址无效。');
    if (this.images.size >= 500) {
      const first = this.images.keys().next().value;
      if (first) this.images.delete(first);
    }
    const id = randomUUID();
    this.images.set(id, url);
    return id;
  }

  imageUrl(id: string): URL {
    const url = this.images.get(id);
    if (!url) throw new MailFailure('business', '邮箱图片已失效，请重新打开邮件。');
    return new URL(url);
  }

  register(source: MailAttachmentSource): MailAttachment {
    while (this.entries.size >= 2000) {
      const first = this.entries.keys().next().value;
      if (first) this.entries.delete(first);
    }
    const id = randomUUID();
    this.entries.set(id, source);
    return {
      id,
      name: source.name,
      size: source.size,
      big: source.big,
      available: source.available,
    };
  }

  fromMessage(entry: MailObject, mailId: string): MailAttachment[] {
    const result: MailAttachment[] = [];
    for (const [field, big] of [
      ['normal_attach', false],
      ['big_attach', true],
    ] as const) {
      for (const value of items(entry[field])) {
        const raw = object(value);
        const name = text(raw.name) || '附件';
        result.push(
          this.register({
            fileId: text(raw.fileid ?? raw.fileid_in_cstore),
            mailId,
            name: name.slice(0, 512),
            size: count(raw.size),
            big,
            available: raw.status === undefined || Number(raw.status) === 0,
            key: text(raw.key) || undefined,
            code: text(raw.code) || undefined,
            bizId: count(raw.bizid ?? raw.bizeid) || (big ? 2 : 50),
            download: text(raw.download_url) || undefined,
          }),
        );
      }
    }
    return result;
  }

  get(id: string): MailAttachmentSource {
    const value = this.entries.get(id);
    if (!value?.available) throw new MailFailure('business', '附件已失效，请重新选择。');
    return value;
  }

  sendParams(ids: readonly string[]): { normal: MailObject[]; big: MailObject[] } {
    const normal: MailObject[] = [],
      big: MailObject[] = [];
    for (const id of ids) {
      const value = this.get(id);
      if (value.big) {
        if (!value.key || !value.code)
          throw new MailFailure('business', '超大附件缺少分享记录，请重新上传。');
        big.push({ name: value.name, key: value.key, code: value.code, bizid: value.bizId ?? 2 });
      } else {
        if (!value.fileId) throw new MailFailure('business', '附件标识无效，请重新选择。');
        normal.push({ name: value.name, fileid: value.fileId, fw_mailid: value.mailId });
      }
    }
    return { normal, big };
  }

  downloadUrl(id: string): URL {
    const value = this.get(id);
    const url = new URL(
      value.download || (value.big ? '/ftn/download' : '/attach/download'),
      MAIL_ORIGIN,
    );
    if (url.protocol === 'http:' && isMailDownloadHost(url.hostname)) url.protocol = 'https:';
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !isMailDownloadHost(url.hostname)
    )
      throw new MailFailure('business', '附件下载地址不受信任。');
    if (!value.download) {
      url.searchParams.set('name', value.name);
      url.searchParams.set('bizid', String(value.bizId ?? (value.big ? 2 : 50)));
      if (value.big) {
        url.searchParams.set('key', value.key ?? '');
        url.searchParams.set('code', value.code ?? '');
      } else url.searchParams.set('fileid', value.fileId);
      if (value.mailId) url.searchParams.set('mailid', value.mailId);
    }
    return url;
  }

  clear(): void {
    this.entries.clear();
    this.images.clear();
  }
}
