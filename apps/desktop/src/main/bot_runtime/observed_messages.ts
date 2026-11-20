import type { AccountSession } from '@weq/account';
import type { DbWatchService, DbWatchHandle, NewMessages } from '@weq/service';
import { createNtMsgDbHook, toRenderElements } from '@weq/service';
import type { ControlObservedMessage } from '@weqbot/control';

type Message = NewMessages['c2c'][number] | NewMessages['group'][number];

export async function projectObservedMessage(
  row: Message,
  uinByUid: (uid: string) => bigint | undefined | null,
  getNickname: (uid: string) => Promise<string | undefined>,
  now: number,
): Promise<ControlObservedMessage | undefined> {
  const time = Number(row.sendTime);
  if (time < now - 120 || (row.msgType === 1n && row.subType === 1n)) return;
  const group = 'targetGroupCode' in row;
  const sender = row.senderUin || uinByUid(row.senderUid);
  const peer = group ? row.targetGroupCode : row.targetUin || uinByUid(row.targetUid);
  if (!sender || !peer || !/^[1-9]\d*$/.test(String(peer))) return;
  const elements: ControlObservedMessage['elements'] = [];
  for (const element of toRenderElements(row.elements)) {
    switch (element.type) {
      case 'text':
        elements.push({ kind: 'text', textContent: element.data.textContent });
        break;
      case 'at': {
        const { atTargetUid, textContent } = element.data;
        const target = atTargetUid === 'all' ? 'all' : atTargetUid && uinByUid(atTargetUid);
        elements.push(
          target ? { kind: 'at', atTargetUin: String(target) } : { kind: 'text', textContent },
        );
        break;
      }
      case 'face':
        elements.push({ kind: 'face', faceId: element.data.faceId, innerId: element.data.innerId });
        break;
      case 'pic':
      case 'ptt':
      case 'video':
        elements.push({
          kind: element.type,
          fileName: element.data.fileName,
          fileToken: element.data.fileToken,
          subType: element.data.subType,
          summary: element.data.summary,
        });
        break;
      case 'file':
        elements.push({
          kind: 'file',
          fileName: element.data.fileName,
          fileSize: Number(element.data.fileSize),
          fileUuid: element.data.fileToken,
        });
        break;
      case 'ark':
        elements.push({ kind: 'ark', arkData: element.data.arkData });
        break;
      case 'markdown':
        elements.push({ kind: 'markdown', content: element.data.markdownContent });
        break;
      case 'mface':
        elements.push({
          kind: 'mface',
          marketEmoticonId: element.data.marketEmoticonIdHex,
          emojiPackId: element.data.emojiPackId,
          encryptKey: element.data.encryptKey,
        });
        break;
      case 'multiMsg':
        elements.push({ kind: 'forward', resId: element.data.resId });
        break;
      case 'reply':
        if (element.data.origMsgSeq > 0) {
          elements.push({ kind: 'reply', origMsgSeq: element.data.origMsgSeq });
        }
        break;
      default:
        elements.push({ kind: 'text', textContent: `[${element.type}]` });
    }
  }
  if (elements.length === 0) return;
  const name = row.senderUid ? await getNickname(row.senderUid).catch(() => undefined) : undefined;
  const clientSequence = group ? undefined : Number(row.clientSeq ?? 0n);
  return {
    messageId: String(row.msgId),
    scene: group ? 'group' : 'private',
    time,
    seq: clientSequence ?? Number(row.msgSeq),
    ...(group ? {} : { clientSequence, ntMsgSeq: Number(row.msgSeq) }),
    ...(row.msgRandom === undefined ? {} : { random: Number(row.msgRandom) }),
    peer: { id: String(peer), ...(group ? {} : { uid: row.targetUid }) },
    sender: { id: String(sender), ...(row.senderUid ? { uid: row.senderUid } : {}), name },
    elements,
  };
}

/** 和实时消息、SSE 分开订阅，关闭这些功能不会让已配置的 OneBot 停止收消息。 */
export function watchObservedMessages(
  watch: Pick<DbWatchService, 'mount'>,
  session: AccountSession,
  isCurrent: () => boolean,
  getNickname: (uid: string) => Promise<string | undefined>,
  deliver: (message: ControlObservedMessage) => Promise<boolean>,
): DbWatchHandle {
  return watch.mount(
    createNtMsgDbHook(session, {
      onDbChanged() {},
      async onNewMessages({ c2c, group }) {
        for (const row of [...c2c, ...group]) {
          if (!isCurrent()) return;
          const message = await projectObservedMessage(
            row,
            (uid) => session.uidMap.uinByUid(uid),
            getNickname,
            Date.now() / 1000,
          );
          if (!isCurrent()) return;
          if (message && !(await deliver(message)) && isCurrent()) {
            // 由数据库订阅退避重读，同一页中已接受的消息由 daemon 去重。
            throw new Error('OneBot 暂未接受本地消息');
          }
        }
      },
    }),
  );
}
