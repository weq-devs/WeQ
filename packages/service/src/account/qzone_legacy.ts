import { sendPacket, type TrpcNative } from '@weq/protocol';
import {
  fieldsOf,
  integerOf,
  map,
  qzoneLegacyRequest,
  qzoneLegacyResponse,
  textOf,
  type JceValue,
} from './qzone_legacy_wire';

export interface QzoneTailOption {
  id: string;
  label: string;
  selected: boolean | null;
  editable: boolean;
}
export interface QzoneReplyTarget {
  rootId: string;
  rootUin: string;
  targetUin: string;
  nickname: string;
}
export function resolveQzoneReplyTarget(
  comments: {
    id: string;
    uin: string;
    nickname: string;
    isReply?: boolean;
    parentCommentId?: string;
  }[],
  targetId: string,
): QzoneReplyTarget {
  const target = comments.find((comment) => comment.id === targetId);
  const root = target?.isReply
    ? comments.find((comment) => !comment.isReply && comment.id === target.parentCommentId)
    : target;
  if (!target || !root) throw new Error('目标评论未取得，请刷新评论后重试。');
  return { rootId: root.id, rootUin: root.uin, targetUin: target.uin, nickname: target.nickname };
}

export function qzoneReplyMention(uin: string, nickname: string) {
  if (!/^[1-9]\d{4,19}$/.test(uin)) throw new Error('回复对象无效。');
  const chars = Array.from(nickname);
  const name = chars.length > 10 ? `${chars.slice(0, 10).join('')}...` : nickname;
  const escaped = name
    .replaceAll('%', '%25')
    .replaceAll(',', '%2C')
    .replaceAll('}', '%7D')
    .replaceAll('{', '%7B')
    .replaceAll(':', '%3A');
  return `@{uin:${uin},nick:${escaped},who:1,auto:1}`;
}

let sequence = 0;
export class QzoneLegacyService {
  constructor(
    private readonly nt: TrpcNative,
    private readonly resolvePid: () => number,
    private readonly selfUin: string,
  ) {}

  private async call(
    key: string,
    type: string,
    body: Record<number, JceValue>,
    beforeSend?: () => void,
  ) {
    const pid = this.resolvePid();
    const packet = qzoneLegacyRequest(this.selfUin, key, type, body, ++sequence);
    beforeSend?.();
    // 写入只发一次；超时不得自动重试，交给界面读回核对。
    const response = await sendPacket(this.nt, pid, `SQQzoneSvc.${key}`, packet);
    beforeSend?.();
    if (this.resolvePid() !== pid) throw new Error('QQ 会话已切换，请重新打开空间。');
    return qzoneLegacyResponse(response, key);
  }

  async reply(
    owner: string,
    tid: string,
    content: string,
    target: QzoneReplyTarget,
    beforeSend?: () => void,
  ) {
    if (
      !/^[1-9]\d{4,19}$/.test(owner) ||
      !/^[1-9]\d{4,19}$/.test(target.rootUin) ||
      !target.rootId ||
      !content.trim()
    )
      throw new Error('说说回复定位信息不完整。');
    const result = await this.call(
      'addReply',
      'NS_MOBILE_OPERATION.operation_addreply_req',
      {
        0: 311,
        1: BigInt(this.selfUin),
        2: BigInt(owner),
        3: BigInt(target.rootUin),
        4: tid,
        5: target.rootId,
        6: qzoneReplyMention(target.targetUin, target.nickname) + content,
        7: 0,
        8: map([]),
        10: 0,
        11: map([]),
      },
      beforeSend,
    );
    const id = textOf(result.get('3'));
    if (integerOf(result.get('0')) !== 0 || !id || textOf(result.get('2')))
      throw new Error(textOf(result.get('1')) || '回复未确认，请先刷新评论核对后再试。');
    return { id };
  }

  async forward(owner: string, tid: string, reason: string, beforeSend?: () => void) {
    if (!/^[1-9]\d{4,19}$/.test(owner) || !/^[A-Za-z0-9_-]{1,128}$/.test(tid))
      throw new Error('转发目标无效。');
    // 仅提交普通说说身份和文案；未验证的相册／同时评论模式不填操作位。
    const result = await this.call(
      'forward',
      'NS_MOBILE_OPERATION.operation_forward_req',
      {
        0: 311,
        1: 0,
        2: BigInt(this.selfUin),
        3: BigInt(owner),
        4: tid,
        6: reason,
      },
      beforeSend,
    );
    const id = textOf(result.get('2'));
    if (integerOf(result.get('0')) !== 0 || !id || textOf(result.get('3')))
      throw new Error(textOf(result.get('1')) || '转发未确认，请先查看自己的空间后再试。');
    return { id };
  }

  async tails(): Promise<QzoneTailOption[]> {
    const result = await this.call('getDeviceInfo', 'NS_MOBILE_EXTRA.GetDeviceInfoReq', {
      0: BigInt(this.selfUin),
    });
    const rows = result.get('0');
    if (!Array.isArray(rows) || rows.length > 200) throw new Error('手机尾巴选项未取得，请重试。');
    const options = rows.map((row) => {
      const fields = fieldsOf(row),
        selected = integerOf(fields.get('5'));
      return {
        id: textOf(fields.get('3')),
        label: textOf(fields.get('4')) || textOf(fields.get('0')) || '不展示',
        selected: selected === 0 || selected === 1 ? selected === 1 : null,
        editable: integerOf(fields.get('6')) === 1,
      };
    });
    if (
      rows.some((row) => typeof fieldsOf(row).get('3') !== 'string') ||
      new Set(options.map((row) => row.id)).size !== options.length
    )
      throw new Error('手机尾巴选项身份无效。');
    return options;
  }

  async setTail(id: string, beforeSend?: () => void) {
    const options = await this.tails();
    if (!options.some((option) => option.id === id))
      throw new Error('尾巴选项已变化，请刷新后选择。');
    const result = await this.call(
      'setUserTail',
      'NS_MOBILE_EXTRA.SetUserTailReq',
      { 0: id, 1: '', 2: 0 },
      beforeSend,
    );
    if (typeof result.get('0') !== 'string' || typeof result.get('1') !== 'string')
      throw new Error('手机尾巴设置未确认，请刷新选项核对。');
  }
}
