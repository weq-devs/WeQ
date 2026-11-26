import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadUrlToFile, getHost, type SendForwardNodeInput } from '@weq/service';
import type { ForwardedFile } from '@weqbot/protocol';
import { chatFileForwardInput, type ChatFileForwardSource } from '../shared/chat_file_forward';
import { PICKED_BROWSER_FILE_MAX_BYTES } from '../shared/browser_file_upload';
import type { AccountServices } from './context/app_context';
import { findMediaElement } from './media_protocol';
import { messageMediaLocations, savedChatFileKey } from './message_media_local';

type Destination = { peerType: 'c2c' | 'group'; targetId: string };
type PendingFile = { key: string; name: string; size: number };
type FilePlan =
  | { kind: 'reference'; file: ForwardedFile }
  | { kind: 'local'; path: string }
  | { kind: 'download'; needs: PendingFile; md5: string; url: string };

const hexWithSize = (input: unknown, length: number): string => {
  const hex = input instanceof Uint8Array ? Buffer.from(input).toString('hex') : input;
  return typeof hex === 'string' && hex.length === length && /^[a-f0-9]+$/i.test(hex)
    ? hex.toLowerCase()
    : '';
};

async function matchesFile(path: string, size: number, md5: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== size) return false;
  if (!md5) return true;
  const hash = createHash('md5');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex') === md5;
  } catch {
    return false;
  }
}

/** Prepare first, then publish. Resolving a download URL never transfers the file body. */
export class ChatFileForward {
  private readonly plans = new Map<string, Promise<FilePlan>>();
  private readonly staged = new Map<string, Promise<string>>();
  private directory?: string;

  constructor(
    private readonly services: AccountServices,
    private readonly target: Destination,
    private readonly confirmed: ReadonlySet<string>,
    private readonly check: () => void,
  ) {}

  private async plan(source: ChatFileForwardSource): Promise<FilePlan> {
    this.check();
    const found = await findMediaElement(
      source.msgId,
      'file',
      source.token,
      source.fwdMsgId,
      source.fwdKind,
      source.fwdResId,
    );
    this.check();
    if (
      !found ||
      found.element.fileToken !== source.token ||
      found.element.fileName !== source.name
    )
      throw new Error(`找不到原文件「${source.name}」`);
    const { element } = found;
    const groupId = Number(source.conv);
    const isGroup =
      found.conv === 'group' ||
      (found.conv === null && (Boolean(element.busId) || element.fileToken.startsWith('/')));
    const hasSource = !isGroup || (Number.isSafeInteger(groupId) && groupId > 0);
    const size = element.fileSize;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0)
      throw new Error(`文件「${source.name}」大小无法确认`);
    const md5 =
      hexWithSize(element.md5Bytes2, 32) ||
      hexWithSize(element.md5Bytes, 32) ||
      hexWithSize(element.md5, 32) ||
      hexWithSize(element.contentHash, 32);
    const key = savedChatFileKey(source);
    if (source.token && hasSource && !this.confirmed.has(key)) {
      try {
        const file = await this.services.messageSend.prepareFileForward({
          ...this.target,
          source: {
            fileId: source.token,
            fileName: source.name,
            fileSize: size,
            md5Hex: md5,
            sha1Hex: hexWithSize(element.contentHash, 40),
            fileHash: element.transferFlag45504,
            ...(isGroup ? { groupId, busId: element.busId } : {}),
          },
          beforeSend: this.check,
        });
        this.check();
        // 群文件转入私聊的回包不带下载 CRC，先确认目标标识能用于下载。
        if (isGroup && this.target.peerType === 'c2c') {
          const url = await this.services.mediaUrl.getPrivateFileUrl(
            file.fileId,
            file.fileHash ?? '',
          );
          if (!url) throw new Error('缺少目标文件下载地址');
          this.check();
        }
        return { kind: 'reference', file };
      } catch {
        // 转存不会发出聊天消息；失败仍可查找原件。发布失败不进入此分支。
        this.check();
      }
    }
    const copies = await messageMediaLocations(
      this.services,
      {
        ...source,
        kind: 'file',
        t: 0,
        md5,
        pack: '',
        hash: '',
        label: source.name,
      },
      true,
    );
    for (const copy of copies) {
      this.check();
      if (copy.available && (await matchesFile(copy.path, size, md5)))
        return { kind: 'local', path: copy.path };
    }
    this.check();
    if (
      !source.token ||
      (found.conv === 'group' && !hasSource) ||
      size === 0 ||
      size > PICKED_BROWSER_FILE_MAX_BYTES
    )
      throw new Error(`「${source.name}」不能直接转发，也没有可重传的本机副本`);
    let url: string;
    try {
      url =
        found.conv === null
          ? await this.services.mediaUrl.resolveFileUrlUnknownScene(groupId, element, source.name)
          : await this.services.mediaUrl.resolveFileUrl(found.conv, groupId, element, source.name);
      if (!url) throw new Error('文件没有下载地址');
    } catch {
      this.check();
      throw new Error(`「${source.name}」无法从 QQ 取回，且本机没有原件`);
    }
    this.check();
    return { kind: 'download', needs: { key, name: source.name, size }, url, md5 };
  }

  prepare(source: ChatFileForwardSource) {
    const key = savedChatFileKey(source);
    let plan = this.plans.get(key);
    if (!plan) {
      plan = this.plan(source);
      this.plans.set(key, plan);
    }
    return plan;
  }

  pending(plan: FilePlan): PendingFile[] {
    return plan.kind === 'download' && !this.confirmed.has(plan.needs.key) ? [plan.needs] : [];
  }

  private async download(plan: Extract<FilePlan, { kind: 'download' }>): Promise<string> {
    if (this.pending(plan).length) throw new Error('下载并重传文件前需要确认');
    this.check();
    this.directory ??= await mkdtemp(join(tmpdir(), 'weq-forward-'));
    const path = join(this.directory, `file-${this.staged.size}`);
    const result = await downloadUrlToFile(plan.url, path, {
      expectedSize: plan.needs.size,
      maxBytes: plan.needs.size,
      expectedMd5: plan.md5 || undefined,
      allowText: true,
      fetcher: getHost().fetchMedia,
    });
    this.check();
    if (!result.ok) throw new Error(`无法下载「${plan.needs.name}」：${result.reason}`);
    return path;
  }

  private async localPath(plan: Exclude<FilePlan, { kind: 'reference' }>): Promise<string> {
    if (plan.kind === 'local') return plan.path;
    let path = this.staged.get(plan.needs.key);
    if (!path) {
      path = this.download(plan);
      this.staged.set(plan.needs.key, path);
    }
    return path;
  }

  async sendFile(source: ChatFileForwardSource) {
    const plan = await this.prepare(source);
    const files = this.pending(plan);
    if (files.length) return { status: 'confirm' as const, files };
    const result =
      plan.kind === 'reference'
        ? await this.services.messageSend.sendPreparedFileForward({
            ...this.target,
            file: plan.file,
            beforeSend: this.check,
          })
        : await this.services.messageSend.sendFile({
            ...this.target,
            path: await this.localPath(plan),
            fileName: source.name,
            beforeSend: this.check,
          });
    if (!result.ok) throw new Error(result.errMsg || 'QQ 未确认文件发送成功');
    return {
      status: 'sent' as const,
      file: {
        fileId: result.fileId,
        result: result.result,
        privateSequence: result.privateSequence,
        random: result.random,
      },
    };
  }

  async sendCard(nodes: SendForwardNodeInput[], title?: string) {
    const locator = (element: object) =>
      'chatFile' in element ? chatFileForwardInput.parse(element.chatFile) : null;
    const files = new Map<string, PendingFile>();
    const prepare = async (rows: SendForwardNodeInput[]) => {
      for (const row of rows) {
        for (const element of row.elements) {
          const source = element.kind === 'file' ? locator(element) : null;
          if (!source) continue;
          for (const file of this.pending(await this.prepare(source))) files.set(file.key, file);
        }
        if (row.innerForward) await prepare(row.innerForward);
      }
    };
    await prepare(nodes);
    if (files.size) return { status: 'confirm' as const, files: [...files.values()] };
    const materialize = async (rows: SendForwardNodeInput[]): Promise<SendForwardNodeInput[]> => {
      const prepared = [];
      for (const row of rows) {
        const elements: SendForwardNodeInput['elements'] = [];
        for (const element of row.elements) {
          if (element.kind !== 'file') {
            elements.push(element);
            continue;
          }
          const source = locator(element);
          if (!source) {
            elements.push({ kind: 'file', source: element.source, fileName: element.fileName });
            continue;
          }
          const plan = await this.prepare(source);
          elements.push(
            plan.kind === 'reference'
              ? { kind: 'file', source: '', fileName: source.name, fileReference: plan.file }
              : { kind: 'file', source: await this.localPath(plan), fileName: source.name },
          );
        }
        prepared.push({
          ...row,
          elements,
          innerForward: row.innerForward && (await materialize(row.innerForward)),
        });
      }
      return prepared;
    };
    const outcome = await this.services.messageSend.sendForward({
      ...this.target,
      title,
      nodes: await materialize(nodes),
      beforeSend: this.check,
    });
    return { status: 'sent' as const, outcome };
  }

  async dispose() {
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
