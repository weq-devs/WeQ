import { formatDateTime } from '@weq/time';
import { MsgType, SendStatus, SendType } from '@weq/codec/proto/msg/40900';

export type MessageFieldValue =
  | string
  | number
  | null
  | { encoding: 'hex'; data: string; bytes: number };
export type MessageRecordFields = {
  table: string;
  columns: Record<string, MessageFieldValue>;
  elements: readonly unknown[];
  cache: readonly unknown[];
  reactions?: readonly unknown[];
  decoration?: { bubbleId: number; fontId: number; widgetId: number } | null;
};

const names: Record<string, string> = {
  '40001': '消息 ID',
  '40002': '消息随机数',
  '40003': '会话内序号',
  '40005': '发送方序号',
  '40010': '会话类型',
  '40011': '消息类型',
  '40012': '消息子类型',
  '40013': '发送来源',
  '40020': '发送者 UID',
  '40021': '对端 UID',
  '40027': '会话分区键',
  '40030': '对端 QQ 号',
  '40033': '发送者 QQ 号',
  '40035': '服务号 AppID',
  '40040': '本机发送标记',
  '40041': '发送状态',
  '40050': '发送时间',
  '40058': '日期',
  '40062': '表情回应',
  '40800': '消息正文',
  '40801': '消息装扮',
  '40900': '引用与转发快照',
};
const chatTypes: Record<number, string> = {
  1: '私聊',
  2: '群聊',
  5: '好友通知',
  6: '群通知',
  8: '数据线',
  99: '临时会话',
  100: '群临时会话',
  101: '好友验证',
  103: '公众号',
  105: '游戏消息',
  106: '附近的人',
  118: '服务号',
  134: '移动端数据线',
};
const messageTypes: Record<number, string> = {
  [MsgType.NULL]: '空消息',
  [MsgType.MIX]: '图文混排',
  [MsgType.FILE]: '文件',
  [MsgType.STRUCT]: '结构化消息',
  [MsgType.GRAY_TIP]: '系统提示',
  [MsgType.PTT]: '语音',
  [MsgType.VIDEO]: '视频',
  [MsgType.MULTI_FORWARD]: '合并转发',
  [MsgType.REPLY]: '引用回复',
  [MsgType.WALLET]: '红包或转账',
  [MsgType.ARK_STRUCT]: '卡片',
  [MsgType.STRUCT_LONG_MSG]: '长文本',
  [MsgType.GIPHY]: '动图',
  [MsgType.GIFT]: '礼物',
  [MsgType.TEXT_GIFT]: '文字礼物',
  [MsgType.ONLINE_FILE]: '在线文件',
  [MsgType.FACE_BUBBLE]: '表情气泡',
  [MsgType.SHARE_LOCATION]: '位置共享',
  [MsgType.ONLINE_FOLDER]: '在线文件夹',
};
const enums: Record<string, Record<number, string>> = {
  '40010': chatTypes,
  '40011': messageTypes,
  '40013': {
    [SendType.RECEIVED]: '收到的消息',
    [SendType.LOCAL]: '本机发送',
    [SendType.OTHER_CLIENT]: '其他设备发送',
    [SendType.FORWARD]: '转发',
  },
  '40040': { 0: '同步副本', 1: '本机发送' },
  '40041': {
    [SendStatus.BLOCKED]: '发送被阻止',
    [SendStatus.PENDING]: '尚未发送成功',
    [SendStatus.SUCCESS]: '发送成功',
    [SendStatus.BANNED]: '消息被封禁',
  },
};

export function messageRecordField(
  field: string,
  value: MessageFieldValue,
  record: MessageRecordFields,
) {
  const name = field === '40027' && record.table === 'group_msg_table' ? '群号' : names[field];
  if (!name || value === null) return { name };
  if (typeof value === 'object') {
    const count =
      field === '40800'
        ? record.elements.length
        : field === '40900'
          ? record.cache.length
          : field === '40062'
            ? record.reactions?.length
            : undefined;
    if (count)
      return {
        name,
        display: `${count} ${field === '40800' ? '个元素' : field === '40900' ? '条快照' : '种回应'}`,
      };
    const dress = field === '40801' ? record.decoration : null;
    if (dress) {
      const items = [
        dress.fontId && `字体 ${dress.fontId}`,
        dress.bubbleId && `气泡 ${dress.bubbleId}`,
        dress.widgetId && `挂件 ${dress.widgetId}`,
      ].filter(Boolean);
      if (items.length) return { name, display: items.join('、') };
    }
    return { name, display: `${value.bytes.toLocaleString('zh-CN')} 字节` };
  }
  const numeric = typeof value === 'number' || /^-?\d+$/.test(value) ? Number(value) : NaN;
  if (field === '40050' || field === '40058') {
    const date = new Date(numeric * 1000);
    const time = formatDateTime(date, 'second');
    return { name, display: field === '40058' ? time.slice(0, 10) : time };
  }
  if (
    (field === '40011' || field === '40012') &&
    numeric === 1 &&
    Number(record.columns['40011']) === 1 &&
    Number(record.columns['40012']) === 1
  )
    return { name, display: '删除或撤回标记' };
  if (field === '40012' && Number(record.columns['40011']) === MsgType.MIX && numeric & 0x2000)
    return { name, display: '含闪照标记' };
  return { name, display: enums[field] ? enums[field][numeric] : String(value) };
}

const snapshotFields: Record<string, string> = {
  msgId: '40001',
  msgRandom: '40002',
  msgSeq: '40003',
  clientSeq: '40005',
  chatType: '40010',
  msgType: '40011',
  subMsgType: '40012',
  sendType: '40013',
  senderUid: '40020',
  targetUid: '40021',
  targetUin: '40030',
  senderUin: '40033',
  sendStatus: '40041',
  sendTime: '40050',
};

export function snapshotRecordFields(snapshot: object): MessageRecordFields {
  const columns = Object.fromEntries(
    Object.entries(snapshot).filter(
      (entry): entry is [string, string | number | null] =>
        entry[1] === null ||
        typeof entry[1] === 'number' ||
        (typeof entry[1] === 'string' &&
          !['protocolRaw', 'proto40801', 'proto40802'].includes(entry[0])),
    ),
  );
  return { table: '', columns, elements: [], cache: [] };
}

export function messageSnapshotField(
  field: string,
  value: MessageFieldValue,
  record: MessageRecordFields,
) {
  const mapped = snapshotFields[field];
  if (mapped) return messageRecordField(mapped, value, record);
  if (field === 'sourceFormat')
    return {
      name: '来源',
      display:
        value === 'native' ? 'QQ 原生漫游' : value === 'protocol' ? 'WeQ 漫游缓存' : undefined,
    };
  if (field === 'sendNick')
    return { name: '发送者昵称', display: typeof value === 'string' ? value : undefined };
  return { name: undefined, display: undefined };
}
