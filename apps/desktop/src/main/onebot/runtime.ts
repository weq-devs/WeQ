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
  accountConfigId,
  type RenderElement,
  type GapFetchedMessage,
  type SendElement,
  type OneBotConfig,
} from '@weq/service';
import type { AppContext } from '../context/app_context';
import { OneBotServer, type BridgeMessage, type Segment } from './server';
import { createActions, groupSummary } from './actions';
import { fullModeAllowed } from '../context/full_mode';
import { MessageRegistry } from './registry';
import { createHistory } from './history';
import { createForward } from './forward';
import { id, integer, text } from './contracts';

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
      type RenderRow = (Omit<C2cMsg, 'elements'> | Omit<GroupMsg, 'elements'>) & {
        elements: RenderElement[];
      };
      async function incoming(
        peerType: 'c2c' | 'group',
        row: RenderRow,
        freshOnly = false,
        projectionOnly = false,
      ): Promise<BridgeMessage | null> {
        requireActive();
        const senderUin = Number(row.senderUin || session!.uidMap.uinByUid(row.senderUid) || 0);
        if (
          (!senderUin && !projectionOnly) ||
          (freshOnly && Number(row.sendTime) < Date.now() / 1000 - 120) ||
          (freshOnly && row.msgType === 1n && row.subType === 1n)
        )
          return null;
        const targetId =
          'targetGroupCode' in row
            ? row.targetGroupCode
            : String(row.targetUin || session!.uidMap.uinByUid(row.targetUid) || '');
        if (!projectionOnly && !/^[1-9]\d*$/.test(targetId)) return null;
        const conv = 'targetUid' in row ? row.targetUid : targetId;
        const base = {
          peerType,
          targetId,
          time: Number(row.sendTime),
          senderUin,
          nickname: '',
        };
        const message: Segment[] = [];
        for (const el of row.elements) {
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
              if (projectionOnly) {
                message.push({ type: 'text', data: { text: '[引用]' } });
                break;
              }
              const senderUin =
                el.data.origSenderUin ||
                Number(session!.uidMap.uinByUid(el.data.origSenderUid) ?? 0);
              if (senderUin && el.data.origMsgSeq > 0) {
                const reference = {
                  ...base,
                  senderUin,
                  time: el.data.origMsgTime,
                  sequence: el.data.origMsgSeq,
                  location: {
                    conv,
                    msgSeq: peerType === 'group' ? el.data.origMsgSeq : 0,
                    clientSeq: peerType === 'c2c' ? el.data.origMsgSeq : 0,
                    random: 0,
                  },
                  message: [],
                };
                message.push({
                  type: 'reply',
                  data: {
                    id: String(
                      server.reference({
                        ...reference,
                        key: `reference:${peerType}:${targetId}:${senderUin}:${el.data.origMsgSeq}:${el.data.origMsgTime}`,
                      }),
                    ),
                  },
                });
              }
              break;
            }
            case 'multiMsg':
              message.push({ type: 'forward', data: { id: el.data.resId } });
              break;
            case 'face':
              message.push({ type: 'face', data: { id: String(el.data.faceId) } });
              break;
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
                if (!path && el.type === 'pic' && freshOnly)
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
              else if (!freshOnly)
                message.push({
                  type,
                  data: { file: el.data.fileName, name: el.data.fileName, available: false },
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
        if (!message.length) {
          if (freshOnly) return null;
          message.push({ type: 'text', data: { text: '[消息内容不可用]' } });
        }
        const profile = projectionOnly ? null : await services!.profile.getProfile(row.senderUid);
        requireActive();
        return {
          ...base,
          key: `${peerType}:${targetId}:${row.msgId}`,
          nickname: profile?.nick ?? String(row.senderUin),
          sequence: Number(
            peerType === 'group' ? row.msgSeq : 'clientSeq' in row ? (row.clientSeq ?? 0n) : 0n,
          ),
          location: {
            conv,
            msgId: String(row.msgId),
            msgSeq: Number(row.msgSeq),
            clientSeq: Number('clientSeq' in row ? (row.clientSeq ?? 0n) : 0n),
            random: Number(row.msgRandom ?? 0n),
          },
          message,
          forwardId: row.elements.find((element) => element.type === 'multiMsg')?.data.resId,
        };
      }
      async function fromHistory(
        row: GapFetchedMessage,
        knownTarget?: string,
      ): Promise<BridgeMessage | null> {
        const targetId =
          row.kind === 'group'
            ? row.conv
            : (knownTarget ?? String(session!.uidMap.uinByUid(row.conv) ?? ''));
        return incoming(row.kind, {
          msgId: BigInt(row.msgId),
          msgSeq: BigInt(row.msgSeq),
          msgRandom: BigInt(row.msgRandom ?? '0'),
          clientSeq: BigInt(row.clientSeq ?? '0'),
          targetUid: row.conv,
          targetUin: BigInt(targetId || '0'),
          ...(row.kind === 'group' ? { targetGroupCode: row.conv } : {}),
          senderUid: row.senderUid,
          senderUin: BigInt(row.senderUin || '0'),
          sendTime: BigInt(row.sendTime),
          elements: row.elements,
        });
      }

      async function convert(
        segments: Segment[],
        directory: string,
        budget = { bytes: 0 },
      ): Promise<SendElement[]> {
        const elements: SendElement[] = [];
        for (const segment of segments) {
          requireActive();
          switch (segment.type) {
            case 'text':
              elements.push({ kind: 'text', textContent: text(segment.data.text) });
              break;
            case 'at': {
              const qq = String(segment.data.qq ?? '');
              elements.push(
                qq === 'all'
                  ? { kind: 'at', atTargetUid: 'all' }
                  : { kind: 'at', atTargetUin: Number(id(qq)) },
              );
              break;
            }
            case 'image': {
              const candidate =
                typeof segment.data.url === 'string' &&
                server.sourcePath(segment.data.url) !== segment.data.url
                  ? segment.data.url
                  : segment.data.file;
              const source = await mediaSource(
                server.sourcePath(candidate),
                directory,
                elements.length,
              );
              budget.bytes += (await stat(source)).size;
              if (budget.bytes > 64 * 1024 * 1024)
                throw new Error('单次消息或合并转发的媒体总量超过 64 MiB');
              const name = typeof segment.data.name === 'string' ? segment.data.name : undefined;
              elements.push({ kind: 'image', source, ...(name ? { fileName: name } : {}) });
              break;
            }
            case 'reply': {
              const original = await server.resolve(
                integer(segment.data.id, undefined, -2147483647, -1),
              );
              if (!original.sequence) throw new Error('引用缺少原生序号');
              elements.push({
                kind: 'reply',
                origMsgSeq: original.sequence,
                origSenderUin: original.senderUin,
                origMsgTime: original.time,
              });
              break;
            }
            case 'forward':
              elements.push({ kind: 'forward', resId: text(segment.data.id) });
              break;
            default:
              throw new Error(`暂不支持发送 ${segment.type} 段`);
          }
        }
        requireActive();
        return elements;
      }
      async function readMessage(message: BridgeMessage): Promise<BridgeMessage | null> {
        requireActive();
        if (message.fileId)
          return {
            ...message,
            message: [
              {
                type: 'file',
                data: {
                  file_id: message.fileId,
                  name: message.fileName ?? '',
                  file_size: message.fileSize ?? 0,
                },
              },
            ],
          };
        const loc = message.location;
        if (!loc) return null;
        let row: RenderRow | null = null;
        if (
          loc.msgId &&
          BigInt(loc.msgId) <= 0x7fffffffffffffffn &&
          BigInt(loc.msgId) >= -0x8000000000000000n
        )
          row =
            message.peerType === 'group'
              ? await services!.msgs.getGroupMessageById(loc.conv, BigInt(loc.msgId))
              : await services!.msgs.getC2cMessageById(loc.conv, BigInt(loc.msgId));
        requireActive();
        if (
          row &&
          ('targetGroupCode' in row ? row.targetGroupCode !== loc.conv : row.targetUid !== loc.conv)
        )
          row = null;
        if (
          row &&
          (Number(row.senderUin) !== message.senderUin ||
            Number(row.sendTime) !== message.time ||
            (loc.random && Number(row.msgRandom) !== loc.random))
        )
          row = null;
        let seq = loc.msgSeq;
        if (!row && !seq && loc.clientSeq && message.peerType === 'c2c') {
          seq = Number(
            (await services!.msgs.resolveC2cReplySeq(
              loc.conv,
              BigInt(loc.clientSeq),
              BigInt(message.senderUin),
              BigInt(message.time),
            )) ??
              (await services!.gapHistory.resolveReplySeq(
                loc.conv,
                String(loc.clientSeq),
                String(message.senderUin),
                String(message.time),
              )) ??
              0,
          );
          requireActive();
        }
        if (!row && seq > 0) {
          const rows =
            message.peerType === 'group'
              ? await services!.msgs.getGroupFrom(loc.conv, BigInt(seq), 200)
              : await services!.msgs.getC2cFrom(loc.conv, BigInt(seq), 200);
          requireActive();
          const matches = rows.filter(
            (item) =>
              Number(item.msgSeq) === seq &&
              Number(item.senderUin) === message.senderUin &&
              Number(item.sendTime) === message.time &&
              (!loc.random || Number(item.msgRandom) === loc.random),
          );
          if (matches.length > 1) throw new Error('引用定位存在歧义，无法确定原消息');
          row = matches[0] ?? null;
          if (!row) {
            const cached = await services!.gapHistory.cached(message.peerType, loc.conv, seq, seq);
            requireActive();
            const cachedMatches = cached.filter(
              (item) =>
                Number(item.senderUin) === message.senderUin &&
                Number(item.sendTime) === message.time &&
                (!loc.random || Number(item.msgRandom) === loc.random),
            );
            if (cachedMatches.length > 1) throw new Error('引用缓存存在歧义，无法确定原消息');
            const found = cachedMatches[0];
            if (found) return fromHistory(found, message.targetId);
          }
        }
        return row ? incoming(message.peerType, row) : null;
      }
      const cache = ctx.bootstrap?.userConfig.cacheDir?.('onebot');
      const registry = new MessageRegistry(
        cache
          ? join(cache, `${accountConfigId(session.context.uin, session.msgDbPath)}.json`)
          : undefined,
      );
      const actions = createActions(services, session, requireActive, imageReady);
      const history = createHistory(services, session, requireActive, () => server, fromHistory);
      const forward = createForward(
        services,
        session,
        requireActive,
        () => server,
        async (elements, uin, uid, time) =>
          (
            await incoming(
              'group',
              {
                targetGroupCode: '',
                msgId: 0n,
                msgSeq: 0n,
                senderUid: uid,
                senderUin: BigInt(uin),
                sendTime: BigInt(time),
                elements,
              },
              false,
              true,
            )
          )?.message ?? [],
        convert,
      );
      server = new OneBotServer(
        {
          registry,
          readMessage,
          async recall(message) {
            requireActive();
            const loc = message.location;
            if (!loc?.msgSeq || (message.peerType === 'c2c' && (!loc.clientSeq || !loc.random)))
              throw new Error('消息缺少完整撤回定位信息');
            const params = {
              kind: message.peerType,
              conv: loc.conv,
              sequence: loc.msgSeq,
              clientSequence: loc.clientSeq,
              random: loc.random,
              timestamp: message.time,
            };
            const send = () => {
              requireActive();
              return services.groupModeration.recallMessage(params);
            };
            if (services.antiRecall.protects(message.peerType, loc.conv))
              await services.gapHistory.withSelfRecallProtection(params, send);
            else await send();
          },
          async reaction(message, code, isSet) {
            requireActive();
            if (message.peerType !== 'group' || !message.location?.msgSeq)
              throw new Error('当前仅支持对可定位的群消息贴表情');
            if (!/^\d+$/.test(code)) throw new Error('表情 ID 无效');
            await services.interaction.setMessageReaction({
              groupId: message.targetId,
              sequence: message.location.msgSeq,
              code,
              isSet,
            });
          },
          version: () => getHost().appVersion(),
          action(action, params) {
            if (action === 'get_group_msg_history' || action === 'get_friend_msg_history')
              return history(action === 'get_group_msg_history' ? 'group' : 'c2c', params);
            if (
              ['get_forward_msg', 'send_group_forward_msg', 'send_private_forward_msg'].includes(
                action,
              )
            )
              return forward(action, params);
            return actions(action, params);
          },
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
          async group(id, noCache) {
            return groupSummary(services, id, noCache ?? false, requireActive);
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
                  fileName: outcome.fileName,
                  fileSize: outcome.fileSize,
                  message: [
                    {
                      type: 'file',
                      data: {
                        file_id: outcome.fileId,
                        name: outcome.fileName,
                        file_size: outcome.fileSize,
                      },
                    },
                  ],
                };
              }
              const elements = await convert(segments, directory);
              if (reply)
                elements.unshift({
                  kind: 'reply',
                  origMsgSeq: reply.sequence,
                  origSenderUin: reply.senderUin,
                  origMsgTime: reply.time,
                });
              if (!segments.length) throw new Error('消息正文不能为空');
              requireActive();
              const outcome = await services.messageSend.sendElements({
                ...target,
                elements,
                beforeSend: requireActive,
              });
              if (!outcome.ok) throw new Error(outcome.errMsg || 'QQ 拒绝发送消息');
              requireActive();
              return {
                ...target,
                key: `sent:${target.peerType}:${target.targetId}:${outcome.random}:${randomBytes(8).toString('hex')}`,
                senderUin: Number(session.context.uin),
                nickname: '',
                time: outcome.timestamp,
                sequence:
                  target.peerType === 'group'
                    ? outcome.groupSequence
                    : (outcome.clientSequence ?? 0),
                location: {
                  conv:
                    target.peerType === 'group'
                      ? target.targetId
                      : outcome.uid || session.uidMap.uidByUin(BigInt(target.targetId)) || '',
                  msgSeq:
                    target.peerType === 'group' ? outcome.groupSequence : outcome.privateSequence,
                  clientSeq: outcome.clientSequence ?? 0,
                  random: outcome.random,
                },
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
                      const msg = await incoming(
                        kind,
                        { ...row, elements: toRenderElements(row.elements) },
                        true,
                      );
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
    const path = join(directory, `${index}-${randomBytes(8).toString('hex')}`);
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
