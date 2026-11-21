import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import {
  GroupCallSession,
  getLogger,
  isCompleteSessionMaterial,
  resolveDeviceGuid,
  resolveSsoClientSnapshot,
  type GroupCallSignaling,
  type GroupCallTransport,
} from '@weq/service';
import { groupCall, invokeTrpc } from '@weqbot/protocol';
import { recordingsRootFor } from './call_recording_store';
import { CallUdpTrace, type TracedDatagram } from './call_udp_trace';
import { accountEventBus, getAppContext, requireAttachEnabled } from './context/app_context';
import { GroupCallAudioCodec } from './group_call_audio';

export interface GroupCallPerson {
  uin: number;
  uid: string;
  name: string;
}

interface ActiveGroupCall {
  id: string;
  groupId: string;
  account: NonNullable<ReturnType<typeof getAppContext>['account']>;
  session: GroupCallSession | undefined;
}

let active: ActiveGroupCall | undefined;
const logger = getLogger().child({ scope: 'group-call' });

export function hasGroupCall(): boolean {
  return active !== undefined;
}

export function currentGroupCall(id?: string) {
  const call = active;
  if (!call || (id && call.id !== id) || getAppContext().account !== call.account) return undefined;
  return call;
}

export async function startGroupCall(input: {
  expectedAccountUin: string;
  groupId: string;
  uids: string[];
  media: 'audio' | 'video';
}) {
  requireAttachEnabled();
  if (active) throw new Error('当前已有通话，请先挂断');
  const { account, platform, services, bootstrap } = getAppContext();
  if (!account || !platform || !services || !bootstrap || !account.selfUid)
    throw new Error('账号未就绪');
  const uin = account.context.uin;
  if (uin !== input.expectedAccountUin) throw new Error('账号已切换');
  const uid = account.selfUid;
  const pid = platform.resolveQqPid(uin);
  if (!pid) throw new Error('请先登录 QQ');

  const call: ActiveGroupCall = {
    id: randomUUID(),
    groupId: input.groupId,
    account,
    session: undefined,
  };
  active = call;
  const nt = platform.native.ntHelper;
  let connection: number | undefined;
  let trace: CallUdpTrace | null = null;
  const abort = new AbortController();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    accountEventBus.off('closing', closeOnAccountChange);
    try {
      try {
        if (connection !== undefined) {
          try {
            await nt.detachPushSink?.(connection);
          } finally {
            await nt.closeSession?.(connection);
          }
        }
      } finally {
        await trace?.stop();
      }
    } catch (error) {
      logger.warn('群通话资源释放失败', { error: String(error) });
    } finally {
      if (active === call) active = undefined;
    }
  };
  const closeOnAccountChange = () => {
    abort.abort();
    void call.session?.hangup().catch(() => {});
  };
  accountEventBus.on('closing', closeOnAccountChange);
  try {
    const targets = await resolveInvitees(call, input.uids);
    const record = services.accountConfig.getRecord();
    const saved = record?.session;
    const material =
      (saved?.pid ?? record?.qqPid) === pid && isCompleteSessionMaterial(saved)
        ? saved
        : await bootstrap.attachHook.ensure(pid, { uin, uid }, abort.signal);
    const guid = record?.guid || resolveDeviceGuid(nt, platform);
    if (!guid || !isCompleteSessionMaterial(material)) throw new Error('QQ 会话凭据未就绪');
    const client = await resolveSsoClientSnapshot(nt, platform, pid, { uin, uid, guid });
    const media = input.media === 'video' ? 2 : 1;
    const sessionConfig = {
      ...client.identity,
      a2: Buffer.from(material.a2, 'hex'),
      d2: Buffer.from(material.d2, 'hex'),
      d2Key: Buffer.from(material.d2Key, 'hex'),
      secToken: material.secToken,
    };
    abort.signal.throwIfAborted();

    const listeners = new Map<string, Set<(body: Uint8Array) => void>>();
    if (nt.openSession && nt.sendPacketBySession && nt.attachPushSink && nt.closeSession) {
      const opened = await nt.openSession({
        mode: 1,
        wrapperPath: client.wrapperPath,
        session: sessionConfig,
      });
      connection = opened.sessionId;
      await nt.attachPushSink(connection, (error, frame) => {
        if (error || !frame) return;
        for (const listener of listeners.get(frame.command) ?? []) {
          try {
            listener(frame.body);
          } catch {
            // 单条无法识别的推送不影响通话。
          }
        }
      });
    } else {
      await nt.setSsoSession(pid, sessionConfig, client.wrapperPath);
    }
    const transport = connection === undefined ? nt : { sendPacket: nt.sendPacketBySession! };
    const target = connection ?? pid;
    const signaling: GroupCallSignaling = {
      create: async (params) => ({
        room: await invokeTrpc(transport, target, groupCall.CreateGroupRoom, params),
      }),
      multiTerminalSync: (params) =>
        invokeTrpc(transport, target, groupCall.MultiTerminalSync, params),
      invite: async (params) => {
        const receipt = await invokeTrpc(transport, target, groupCall.InviteToGroupRoom, params);
        return receipt.invited.filter((entry) => entry.accepted).map((entry) => entry.uid);
      },
      query: (params) => invokeTrpc(transport, target, groupCall.QueryGroupRoom, params),
      removeMember: (params) =>
        invokeTrpc(transport, target, groupCall.RemoveGroupCallMember, params),
      push:
        connection === undefined
          ? undefined
          : {
              subscribe: (command, listener) => {
                const subscribers = listeners.get(command) ?? new Set();
                listeners.set(command, subscribers);
                subscribers.add(listener);
                return () => {
                  subscribers.delete(listener);
                };
              },
              send: async (command, body) => {
                await transport.sendPacket(target, command, Buffer.from(body), false);
              },
            },
    };
    const recording = bootstrap.userConfig.getSettings().callRecording;
    if (recording?.udpTrace) {
      const root = recording.dir ?? recordingsRootFor(platform.appDataRoot(), uin);
      trace = await CallUdpTrace.start({ root, peerUin: `group-${input.groupId}` }).catch(
        (error: unknown) => {
          logger.warn('群通话 UDP 落盘开启失败', { error: String(error) });
          return null;
        },
      );
      if (trace) logger.info('开始记录群通话 UDP', { path: trace.path });
    }
    if (abort.signal.aborted || getAppContext().account !== account) throw new Error('账号已切换');
    const session = new GroupCallSession({
      selfUin: Number(uin),
      selfUid: uid,
      groupId: Number(input.groupId),
      targetUids: targets.map((person) => person.uid),
      memberDirectory: targets,
      media,
      gcsEntryBody: groupCall.buildGroupCallEntryBody(Number(uin), uid, media),
      signaling,
      transport: groupTransport(trace),
      codec: new GroupCallAudioCodec(),
      logger,
    });
    call.session = session;
    session.onUpdate(({ state }) => {
      if (state === 'ended' || state === 'failed') void release().catch(() => {});
    });
    const snapshot = await session.start();
    if (abort.signal.aborted || getAppContext().account !== account) throw new Error('账号已切换');
    return { id: call.id, snapshot, people: targets };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function inviteGroupCallMembers(id: string, uids: string[]) {
  const call = currentGroupCall(id);
  if (!call?.session) throw new Error('通话已结束');
  const people = await resolveInvitees(call, uids);
  call.session.addMemberIdentities(people);
  await call.session.inviteMembers(people.map((person) => person.uid));
  return people;
}

async function resolveInvitees(call: ActiveGroupCall, uids: string[]) {
  const ctx = getAppContext();
  if (ctx.account !== call.account || !ctx.services) throw new Error('账号已切换');
  const unique = [...new Set(uids)].filter((uid) => uid !== call.account.selfUid);
  const rows = await ctx.services.groupInfo.getMembersByUids(BigInt(call.groupId), unique);
  const people = rows
    .filter((row) => row.memberFlag === 0 && row.uin > 0n && unique.includes(row.uid))
    .map((row) => ({
      uin: Number(row.uin),
      uid: row.uid,
      name: row.card || row.nick || String(row.uin),
    }));
  if (!people.length || people.length !== unique.length)
    throw new Error('部分邀请对象的群成员身份不可用');
  return people;
}

function groupTransport(trace: CallUdpTrace | null): GroupCallTransport {
  const socket = createSocket({ type: 'udp6', ipv6Only: false });
  const record = (
    direction: TracedDatagram['direction'],
    payload: Buffer,
    remoteAddress: string,
    remotePort: number,
  ) => {
    if (!trace) return;
    const local = socket.address();
    trace.record({
      direction,
      payload,
      localAddress: local.address,
      localPort: local.port,
      remoteAddress,
      remotePort,
    });
  };
  return {
    bind: () =>
      new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, () => {
          socket.off('error', reject);
          resolve();
        });
      }),
    send: (body, port, ip) => {
      const address = ip.includes(':') ? ip : `::ffff:${ip}`;
      record('c2s', Buffer.from(body), address, port);
      socket.send(body, port, address, (error) => {
        if (error) socket.emit('error', error);
      });
    },
    close: () => {
      try {
        socket.close();
      } catch {
        /* 已释放 */
      }
    },
    onMessage: (listener) => {
      socket.on('message', (body, remote) => {
        record('s2c', body, remote.address, remote.port);
        listener(body, remote);
      });
    },
    onError: (listener) => {
      socket.on('error', listener);
    },
  };
}
