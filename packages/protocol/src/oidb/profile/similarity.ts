import { decode, encode, message } from '../../protobuf';
import { walkProto } from '../../msg/dump';
import type { TrpcNative } from '../../transport';
import { requireUin } from '../write-validation';
import { invokeLegacyOidb } from '../legacy';

export interface ProfileSimilarity {
  targetUin: string;
  items: Array<{ icon: string | null; title: string; wordings: string[] }>;
  /** 兼容先前查询缓存没有来源标记的情况。 */
  source?: 'dna';
}
const dnaRequest = message([
  { name: 'from', tag: 1, type: 'uint64' },
  { name: 'to', tag: 2, type: 'uint64' },
  { name: 'qzone', tag: 4, type: 'bool', force: true },
  { name: 'newDna', tag: 6, type: 'bool', force: true },
]);
const dnaResponse = message([
  { name: 'from', tag: 1, type: 'uint64' },
  { name: 'to', tag: 2, type: 'uint64' },
  {
    name: 'items',
    tag: 14,
    repeated: true,
    type: message([{ name: 'wording', tag: 3, type: 'bytes' }]),
  },
]);
/** 直接读取 QQ 逐项共同资料原文，不自行推断属性或引入聊天小结／友谊时间线。 */
export async function getProfileSimilarity(
  nt: TrpcNative,
  pid: number,
  self: string,
  targetUin: string,
): Promise<ProfileSimilarity> {
  if (self === targetUin) throw new Error('不查询与自己的共同点');
  const from = requireUin(self),
    to = requireUin(targetUin);
  const bytes = await invokeLegacyOidb(
    nt,
    pid,
    0xcf4,
    0,
    'OidbSvc.0xcf4',
    encode(dnaRequest, { from, to, qzone: true, newDna: false }),
    { strict: true },
  );
  walkProto(bytes);
  const data = decode(dnaResponse, bytes, { strict: true });
  if (data.from !== from || data.to !== to) throw new Error('共同资料返回目标不匹配');
  const records = data.items ?? [];
  if (!Array.isArray(records) || records.length > 100) throw new Error('共同资料结构无效');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const wordings: string[] = [];
  for (const record of records) {
    const raw = record as { wording?: Uint8Array };
    if (raw.wording === undefined) continue;
    if (!(raw.wording instanceof Uint8Array) || raw.wording.length > 65536)
      throw new Error('共同资料文案格式无效');
    let text: string;
    try {
      text = decoder.decode(raw.wording);
    } catch {
      throw new Error('共同资料文案编码无效');
    }
    if (text.trim() && !wordings.includes(text)) wordings.push(text);
  }
  return {
    targetUin,
    source: 'dna',
    items: wordings.length ? [{ icon: null, title: '', wordings }] : [],
  };
}
