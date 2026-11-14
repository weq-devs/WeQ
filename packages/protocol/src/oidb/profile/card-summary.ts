import { decode, encode, message } from '../../protobuf';
import { walkProto } from '../../msg/dump';
import { sendPacket, type TrpcNative } from '../../transport';
import { requireUin } from '../write-validation';
import { jceFields, jceStruct, readJce, type JceValue } from './summary-jce';

export const PROFILE_SUMMARY_COMMAND = 'SummaryCard.ReqSummaryCard';
const comm = message([
  { name: 'version', tag: 1, type: 'uint32' },
  { name: 'from', tag: 3, type: 'uint64' },
  { name: 'to', tag: 4, type: 'uint64' },
  { name: 'service', tag: 5, type: 'uint32' },
  { name: 'result', tag: 10, type: 'int32' },
]);
const similarity = message([
  { name: 'icon', tag: 1, type: 'string' },
  { name: 'title', tag: 2, type: 'string' },
  { name: 'wordings', tag: 3, type: 'string', repeated: true },
]);
const similarityResponse = message([
  { name: 'result', tag: 1, type: 'uint32' },
  { name: 'items', tag: 3, type: similarity, repeated: true },
]);
export interface ProfileSimilarity {
  targetUin: string;
  items: Array<{ icon: string | null; title: string; wordings: string[] }>;
}
function uint(value: JceValue | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error('资料卡计数格式无效');
  return value;
}
function summaryRequest(self: string, target: string) {
  const to = requireUin(target),
    from = requireUin(self);
  const header = encode(comm, { version: 1, from, to, service: 22 });
  const inner = encode(message([{ name: 'uin', tag: 1, type: 'uint64' }]), { uin: to });
  const frame = Buffer.alloc(10 + header.length + inner.length);
  frame[0] = 0x28;
  frame.writeUInt32BE(header.length, 1);
  frame.writeUInt32BE(inner.length, 5);
  frame.set(header, 9);
  frame.set(inner, 9 + header.length);
  frame[frame.length - 1] = 0x29;
  return jceFields({
    1: 3,
    2: 0,
    3: 0,
    4: 1,
    5: 'SummaryCardServantObj',
    6: 'ReqSummaryCard',
    7: jceFields({
      0: new Map<JceValue, JceValue>([
        ['ReqHead', jceStruct({ 0: 2 })],
        [
          'ReqSummaryCard',
          jceStruct({
            0: to,
            1: 0,
            2: 0,
            3: 1,
            4: 0,
            5: 0,
            6: Buffer.of(0),
            8: 0,
            9: 0,
            10: Buffer.of(0),
            14: [frame],
            15: 0,
            16: 0,
            18: 0,
            19: [],
            20: 1,
            21: 0,
            22: 0,
            24: 1,
            25: 0,
          }),
        ],
      ]),
    }),
    8: 0,
    9: new Map(),
    10: new Map(),
  });
}
async function summary(nt: TrpcNative, pid: number, self: string, target: string) {
  const outer = readJce(
    await sendPacket(nt, pid, PROFILE_SUMMARY_COMMAND, summaryRequest(self, target)),
  );
  const version = outer.get(1),
    payload = outer.get(7);
  if ((version !== 2 && version !== 3) || !Buffer.isBuffer(payload))
    throw new Error('资料卡响应封装无效');
  const map = readJce(payload).get(0);
  if (!(map instanceof Map)) throw new Error('资料卡响应字典缺失');
  const struct = (key: string) => {
    let value = map.get(key);
    if (version === 2 && value instanceof Map && value.size === 1) value = [...value.values()][0];
    if (!Buffer.isBuffer(value)) throw new Error('资料卡响应结构缺失');
    const decoded = readJce(value),
      row = decoded.get(0);
    if (decoded.size !== 1 || !(row instanceof Map)) throw new Error('资料卡响应结构无效');
    return row;
  };
  const result = uint(struct('RespHead').get(1));
  if (result !== 0) throw new Error(`资料卡读取失败（${result ?? '未知'}）`);
  const row = struct('RespSummaryCard');
  if (String(row.get(23)) !== target) throw new Error('资料卡返回目标不匹配');
  return row;
}
export async function getProfileSimilarity(
  nt: TrpcNative,
  pid: number,
  self: string,
  targetUin: string,
): Promise<ProfileSimilarity> {
  if (self === targetUin) throw new Error('不查询与自己的共同点');
  const row = await summary(nt, pid, self, targetUin);
  const frames = row.get(46);
  if (!Array.isArray(frames)) throw new Error('共同点业务未返回');
  let body: Uint8Array | undefined;
  for (const value of frames) {
    if (!Buffer.isBuffer(value) || value.length < 10 || value[0] !== 0x28 || value.at(-1) !== 0x29)
      throw new Error('共同点业务封装无效');
    const headerLength = value.readUInt32BE(1),
      bodyLength = value.readUInt32BE(5);
    if (10 + headerLength + bodyLength !== value.length) throw new Error('共同点业务长度无效');
    const header = decode(comm, value.subarray(9, 9 + headerLength));
    if (header.service !== 22) continue;
    if (
      body ||
      (header.from !== undefined && String(header.from) !== self) ||
      (header.to !== undefined && String(header.to) !== targetUin)
    )
      throw new Error('共同点业务身份异常');
    if ((header.result ?? 0) !== 0) throw new Error('共同点业务读取失败');
    body = value.subarray(9 + headerLength, 9 + headerLength + bodyLength);
  }
  if (!body?.length) throw new Error('共同点业务未返回');
  walkProto(body);
  const data = decode(similarityResponse, body);
  if ((data.result ?? 0) !== 0) throw new Error('共同点查询失败');
  const items = (data.items ?? []) as Array<{ icon?: string; title?: string; wordings?: string[] }>;
  if (items.length > 100) throw new Error('共同点条目超限');
  return {
    targetUin,
    items: items.map((item) => ({
      icon: item.icon && /^https?:\/\//i.test(item.icon) ? item.icon : null,
      title: item.title ?? '',
      wordings: item.wordings ?? [],
    })),
  };
}
