import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeElement, type MsgCacheRecord } from '@weq/codec';
import {
  toRenderElements,
  type RenderElement,
  type SendElement,
  type SendForwardNodeInput,
} from '@weq/service';
import type { ActionServices, ActionSession } from './actions';
import {
  ActionError,
  id,
  integer,
  parseSegments,
  text,
  type Params,
  type Segment,
} from './contracts';
import type { OneBotServer } from './server';

export function createForward(
  services: ActionServices,
  session: ActionSession,
  requireActive: () => void,
  server: () => Pick<OneBotServer, 'resolve' | 'register' | 'forwardMessage' | 'prepare'>,
  project: (
    elements: RenderElement[],
    uin: number,
    uid: string,
    time: number,
  ) => Promise<Segment[]>,
  convert: (
    segments: Segment[],
    directory: string,
    budget?: { bytes: number },
  ) => Promise<SendElement[]>,
) {
  async function get(resourceId: string) {
    let remaining = 200;
    async function cachedNodes(records: MsgCacheRecord[], depth = 0): Promise<Segment[]> {
      if (depth >= 8) throw new ActionError('合并转发超过 8 层');
      const out: Segment[] = [];
      for (const record of records) {
        if (--remaining < 0) throw new ActionError('合并转发超过 200 个节点');
        const nested =
          record.msgType === 8 && record.subMsgs?.length
            ? await cachedNodes(record.subMsgs as MsgCacheRecord[], depth + 1)
            : null;
        const content =
          nested ??
          (await project(
            toRenderElements((record.elements ?? []).map((el) => decodeElement(el))),
            record.senderUin ?? 0,
            record.senderUid ?? '',
            record.sendTime ?? 0,
          ));
        requireActive();
        out.push({
          type: 'node',
          data: {
            user_id: String(record.senderUin ?? 0),
            nickname: record.sendNick ?? '',
            time: record.sendTime ?? 0,
            content,
          },
        });
      }
      return out;
    }
    const owner = server().forwardMessage(resourceId);
    if (owner?.location?.msgId) {
      const records =
        owner.peerType === 'group'
          ? await services.forwardMsgs.getGroupForward(BigInt(owner.location.msgId))
          : await services.forwardMsgs.getC2cForward(BigInt(owner.location.msgId));
      requireActive();
      if (records.length) return { message: await cachedNodes(records) };
    }
    const records = await services.forwardMsgs.fetchRemote(resourceId);
    requireActive();
    const message: Segment[] = [];
    for (const record of records) {
      if (--remaining < 0) throw new ActionError('合并转发超过 200 个节点');
      const content = await project(
        record.elements,
        Number(record.senderUin ?? 0),
        record.senderUid ?? '',
        Number(record.sendTime ?? 0),
      );
      requireActive();
      message.push({
        type: 'node',
        data: {
          user_id: record.senderUin ?? '0',
          nickname: record.sendNick ?? '',
          time: Number(record.sendTime ?? 0),
          content,
        },
      });
    }
    return { message };
  }

  return async (action: string, p: Params) => {
    requireActive();
    if (action === 'get_forward_msg') {
      const resourceId = text(p.id);
      if (!resourceId || resourceId.length > 2048) throw new ActionError('合并转发 ID 无效');
      return get(resourceId);
    }
    const target = {
      peerType: action === 'send_group_forward_msg' ? ('group' as const) : ('c2c' as const),
      targetId: id(action === 'send_group_forward_msg' ? p.group_id : p.user_id),
    };
    const directory = await mkdtemp(join(tmpdir(), 'weq-onebot-forward-'));
    let remaining = 200;
    const budget = { bytes: 0 };
    async function nodes(value: unknown, depth = 0): Promise<SendForwardNodeInput[]> {
      if (depth >= 8) throw new ActionError('合并转发超过 8 层');
      const out: SendForwardNodeInput[] = [];
      for (const node of parseSegments(value)) {
        if (node.type !== 'node') throw new ActionError('合并转发只接受 node 数组');
        if (--remaining < 0) throw new ActionError('合并转发超过 200 个节点');
        let data = node.data;
        if (data.id !== undefined) {
          const original = await server().resolve(integer(data.id, undefined, -2147483647, -1));
          requireActive();
          data = {
            user_id: original.senderUin,
            nickname: original.nickname,
            time: original.time,
            content: original.message,
          };
        }
        const content = parseSegments(data.content);
        const nested = content.every((segment) => segment.type === 'node');
        if (!nested && content.some((segment) => segment.type === 'node'))
          throw new ActionError('嵌套 node 不能与普通消息段混排');
        out.push({
          userUin: Number(id(data.user_id ?? data.uin ?? session.context.uin)),
          nickname: text(data.nickname ?? data.name, ''),
          time: integer(data.time, Math.floor(Date.now() / 1000)),
          elements: nested ? [] : await convert(content, directory, budget),
          ...(nested ? { innerForward: await nodes(content, depth + 1) } : {}),
        });
        requireActive();
      }
      return out;
    }
    try {
      const prepared = await nodes(p.messages);
      requireActive();
      const key = server().prepare(target);
      const result = await services.messageSend.sendForward({
        ...target,
        nodes: prepared,
        beforeSend: requireActive,
      });
      if (!result.ok) throw new ActionError(result.card.errMsg || '合并转发卡片发送失败', 1500);
      requireActive();
      const card = result.card;
      const messageId = server().register({
        ...target,
        key,
        senderUin: Number(session.context.uin),
        nickname: '',
        time: card.timestamp,
        sequence: target.peerType === 'group' ? card.groupSequence : (card.clientSequence ?? 0),
        location: {
          conv:
            target.peerType === 'group'
              ? target.targetId
              : result.uid || session.uidMap.uidByUin(BigInt(target.targetId)) || '',
          msgSeq: target.peerType === 'group' ? card.groupSequence : card.privateSequence,
          clientSeq: card.clientSequence ?? 0,
          random: card.random,
        },
        forwardId: result.resId,
        message: [{ type: 'forward', data: { id: result.resId } }],
      });
      return { message_id: messageId, forward_id: result.resId };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
