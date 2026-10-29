import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { C2cMsg, GroupMsg } from '@weq/db';
import {
  DbWatchService,
  createNtMsgDbHook,
  toRenderElements,
  getLogger,
  getHost,
  type SendElement,
  type OneBotConfig,
} from '@weq/service';
import type { AppContext } from '../context/app_context';
import { OneBotServer, type BridgeMessage, type Segment } from './server';
import { createActions } from './actions';
import { fullModeAllowed } from '../context/full_mode';

const logger = getLogger().child({ scope: 'onebot' });
let current: OneBotServer | null = null;
let revision = 0;
let queue: Promise<void> = Promise.resolve();
const MAX_FILE = 16 * 1024 * 1024;

export function stopOneBot(): void {
  revision++;
  current?.stop();
  current = null;
}
export function oneBotStatus(): { running: boolean; clients: number } {
  return { running: current !== null, clients: current?.clientCount ?? 0 };
}

/** 串行应用配置；账号在 await 期间切换时，不让旧实例重新占回监听端口。 */
export function applyOneBot(ctx: AppContext, config: OneBotConfig): Promise<void> {
  stopOneBot();
  const generation = revision;
  const session = ctx.account;
  const services = ctx.services;
  const task = queue
    .catch(() => {})
    .then(async () => {
      if (
        generation !== revision ||
        !config.enabled ||
        !session ||
        !services ||
        ctx.accountIsStatic
      )
        return;
      const active = () =>
        generation === revision && ctx.account === session && ctx.services === services;
      const requireActive = () => {
        if (!active()) throw new Error('OneBot 账号已切换或关闭');
      };
      const imageReady = async () => {
        const record = services.accountConfig.getRecord();
        if (!active() || !fullModeAllowed(ctx) || !record?.qqOnline || !record.qqPid) return false;
        const pid = record.qqPid;
        const ready = await ctx.platform?.native.ntHelper.hasSsoSession(pid).catch(() => false);
        return active() && services.accountConfig.getRecord()?.qqPid === pid && Boolean(ready);
      };
      let server: OneBotServer;
      async function incoming(
        peerType: 'c2c' | 'group',
        row: C2cMsg | GroupMsg,
      ): Promise<BridgeMessage | null> {
        requireActive();
        const senderUin = Number(row.senderUin || session!.uidMap.uinByUid(row.senderUid) || 0);
        if (
          !senderUin ||
          senderUin === Number(session!.context.uin) ||
          Number(row.sendTime) < Date.now() / 1000 - 120 ||
          (row.msgType === 1n && row.subType === 1n)
        )
          return null;
        const targetId =
          peerType === 'group'
            ? (row as GroupMsg).targetGroupCode
            : String(
                (row as C2cMsg).targetUin ||
                  session!.uidMap.uinByUid((row as C2cMsg).targetUid) ||
                  '',
              );
        if (!/^[1-9]\d*$/.test(targetId)) return null;
        const base = {
          peerType,
          targetId,
          time: Number(row.sendTime),
          senderUin,
          nickname: '',
        };
        const message: Segment[] = [];
        for (const el of toRenderElements(row.elements)) {
          requireActive();
          switch (el.type) {
            case 'text':
              message.push({ type: 'text', data: { text: el.data.textContent } });
              break;
            case 'at': {
              const uid = el.data.atTargetUid;
              const uin =
                uid === 'all' ? 'all' : uid ? String(session!.uidMap.uinByUid(uid) ?? '') : '';
              message.push(
                uin
                  ? { type: 'at', data: { qq: uin } }
                  : { type: 'text', data: { text: el.data.textContent } },
              );
              break;
            }
            case 'reply': {
              const senderUin =
                el.data.origSenderUin ||
                Number(session!.uidMap.uinByUid(el.data.origSenderUid) ?? 0);
              if (senderUin && el.data.origMsgSeq > 0) {
                const reference = {
                  ...base,
                  senderUin,
                  time: el.data.origMsgTime,
                  sequence: el.data.origMsgSeq,
                  message: [],
                };
                message.push({
                  type: 'reply',
                  data: {
                    id: String(
                      server.reference({
                        ...reference,
                        key: `reference:${peerType}:${targetId}:${senderUin}:${el.data.origMsgSeq}`,
                      }),
                    ),
                  },
                });
              }
              break;
            }
            case 'pic':
            case 'ptt':
            case 'file': {
              const type = el.type === 'pic' ? 'image' : el.type === 'ptt' ? 'record' : 'file';
              let path: string | null = null;
              try {
                const found = await services!.fileSearch.findFile(
                  Number(row.sendTime) * 1000,
                  el.data.fileName,
                  el.type,
                  'md5' in el.data ? el.data.md5 : undefined,
                );
                path = found.source;
                if (!path && el.type === 'pic')
                  path = await services!.mediaDownload.download(el.data.fileToken, {
                    ext: '.jpg',
                    originalUrl: el.data.originalUrl,
                  });
              } catch (error) {
                logger.warn('OneBot media lookup failed', {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              requireActive();
              if (path)
                message.push({
                  type,
                  data: {
                    file: el.data.fileName,
                    name: el.data.fileName,
                    url: server.mediaUrl(path),
                  },
                });
              else
                message.push({
                  type: 'text',
                  data: { text: `[${type}: ${el.data.fileName || '未缓存'}]` },
                });
              break;
            }
            default:
              message.push({ type: 'text', data: { text: `[${el.type}]` } });
          }
        }
        if (!message.length) return null;
        const profile = await services!.profile.getProfile(row.senderUid);
        requireActive();
        return {
          ...base,
          key: `${peerType}:${targetId}:${row.msgId}`,
          nickname: profile?.nick ?? String(row.senderUin),
          sequence: Number(peerType === 'group' ? row.msgSeq : ((row as C2cMsg).clientSeq ?? 0n)),
          message,
        };
      }
      server = new OneBotServer(
        {
          version: () => getHost().appVersion(),
          action: createActions(services, session, requireActive, imageReady),
          async status() {
            if (!active()) return { online: false, good: false };
            const record = services.accountConfig.getRecord();
            const online = Boolean(record?.qqOnline && record.qqPid);
            return { online, good: online && (await imageReady()) };
          },
          async self() {
            requireActive();
            const profile = await services.profile.getSelfProfile();
            requireActive();
            return {
              user_id: Number(session.context.uin),
              nickname: profile?.nick ?? String(session.context.uin),
            };
          },
          async group(id) {
            requireActive();
            const group = await services.groupInfo.getGroupDetail(BigInt(id));
            requireActive();
            return { group_id: Number(id), group_name: group?.groupName ?? id };
          },
          async typing(id, event) {
            requireActive();
            await services.interaction.setInputStatus(id, event);
          },
          async send(target, segments, reply) {
            requireActive();
            const directory = await mkdtemp(join(tmpdir(), 'weq-onebot-'));
            try {
              const files = segments.filter((s) => s.type === 'file');
              if (files.length) {
                if (segments.length !== 1) throw new Error('文件需单独发送，不能与正文或图片混发');
                const file = files[0]!;
                const path = await mediaSource(file.data.file, directory, 0);
                requireActive();
                const outcome = await services.messageSend.sendFile({
                  ...target,
                  path,
                  ...(typeof file.data.name === 'string' ? { fileName: file.data.name } : {}),
                  ...(typeof file.data.folder === 'string' ? { folderId: file.data.folder } : {}),
                  beforeSend: requireActive,
                });
                if (!outcome.ok || !outcome.sent)
                  throw new Error(outcome.errMsg || 'QQ 拒绝发送文件');
                requireActive();
                return {
                  ...target,
                  key: `file:${target.peerType}:${target.targetId}:${outcome.fileId}:${randomBytes(8).toString('hex')}`,
                  senderUin: Number(session.context.uin),
                  nickname: '',
                  time: Math.floor(Date.now() / 1000),
                  sequence: 0,
                  fileId: outcome.fileId,
                  message: segments,
                };
              }
              const elements: SendElement[] = [];
              if (reply)
                elements.push({
                  kind: 'reply',
                  origMsgSeq: reply.sequence,
                  origSenderUin: reply.senderUin,
                  origMsgTime: reply.time,
                });
              for (const segment of segments) {
                switch (segment.type) {
                  case 'text': {
                    if (typeof segment.data.text !== 'string') throw new Error('text 段缺少正文');
                    elements.push({ kind: 'text', textContent: segment.data.text });
                    break;
                  }
                  case 'at': {
                    const qq = String(segment.data.qq ?? '');
                    if (qq !== 'all' && !/^[1-9]\d*$/.test(qq)) throw new Error('@ 目标无效');
                    elements.push(
                      qq === 'all'
                        ? { kind: 'at', atTargetUid: 'all' }
                        : { kind: 'at', atTargetUin: Number(qq) },
                    );
                    break;
                  }
                  case 'image': {
                    const source = await mediaSource(segment.data.file, directory, elements.length);
                    const name =
                      typeof segment.data.name === 'string' ? segment.data.name : undefined;
                    elements.push({ kind: 'image', source, ...(name ? { fileName: name } : {}) });
                    break;
                  }
                  default:
                    throw new Error(`暂不支持发送 ${segment.type} 段`);
                }
              }
              if (!segments.length) throw new Error('消息正文不能为空');
              requireActive();
              const outcome = await services.messageSend.sendElements({ ...target, elements });
              if (!outcome.ok) throw new Error(outcome.errMsg || 'QQ 拒绝发送消息');
              requireActive();
              return {
                ...target,
                key: `sent:${target.peerType}:${target.targetId}:${outcome.random}:${randomBytes(8).toString('hex')}`,
                senderUin: Number(session.context.uin),
                nickname: '',
                time: outcome.timestamp,
                sequence: target.peerType === 'group' ? outcome.groupSequence : 0,
                message: segments,
              };
            } finally {
              await rm(directory, { recursive: true, force: true });
            }
          },
          subscribe(deliver) {
            requireActive();
            const watch = new DbWatchService({ intervalMs: 1000 });
            const handle = watch.mount(
              createNtMsgDbHook(session, {
                onDbChanged() {},
                async onNewMessages(change) {
                  for (const [kind, rows] of [
                    ['c2c', change.c2c],
                    ['group', change.group],
                  ] as const) {
                    for (const row of rows) {
                      if (!active()) return;
                      const msg = await incoming(kind, row);
                      if (msg && active()) deliver(msg);
                    }
                  }
                },
              }),
            );
            return () => handle.unmount();
          },
        },
        config.token,
      );
      try {
        await server.start(config.port);
        if (!active()) {
          server.stop();
          return;
        }
        current = server;
        logger.info('OneBot bridge started', { port: config.port });
      } catch (error) {
        server.stop();
        throw error;
      }
    });
  queue = task;
  return task;
}

async function mediaSource(value: unknown, directory: string, index: number): Promise<string> {
  if (typeof value !== 'string' || !value) throw new Error('媒体段缺少 file');
  if (value.startsWith('base64://')) {
    const encoded = value.slice(9);
    if (encoded.length > Math.ceil(MAX_FILE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      throw new Error('Base64 媒体无效或超过 16 MiB');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE) throw new Error('媒体不能为空或超过 16 MiB');
    const path = join(directory, String(index));
    await writeFile(path, bytes, { mode: 0o600 });
    return path;
  }
  const path = value.startsWith('file://') ? fileURLToPath(value) : value;
  if (!path.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(path))
    throw new Error('媒体 file 需为本地绝对路径或 base64://');
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_FILE) throw new Error('媒体文件无效或超过 16 MiB');
  return path;
}
