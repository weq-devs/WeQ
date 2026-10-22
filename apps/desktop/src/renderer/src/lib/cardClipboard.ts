import { decodeBase64Utf8, parseArkData, resolveArkCard } from '../components/ark/arkCards';
import { groupShareTarget } from '../components/ark/groupShareCard';

const APP_TYPES = new Map([
  ['com.tencent.miniapp.lua', '小程序卡片'],
  ['com.tencent.contact.lua', '名片'],
  ['com.tencent.mobileqq.cardshare', '名片'],
  ['com.tencent.music.lua', '音乐卡片'],
  ['com.tencent.tuwen.lua', '图文卡片'],
  ['com.tencent.together', '一起听歌卡片'],
  ['com.tencent.mannounce', '群公告'],
  ['com.tencent.activity.md', '群活动卡片'],
  ['com.tencent.public.subscribe.standard', '公众号通知卡片'],
  ['com.tencent.security.message', '安全提醒卡片'],
  ['com.tencent.qianbao', 'QQ 钱包卡片'],
  ['com.tencent.multimsg', '聊天记录卡片'],
]);
const META_TYPES = new Map([
  ['news', '链接卡片'],
  ['music', '音乐卡片'],
  ['video', '视频卡片'],
  ['contact', '名片'],
  ['miniapp', '小程序卡片'],
  ['mail', '邮箱通知卡片'],
  ['plainText', '通知卡片'],
  ['singlePic', '图片卡片'],
  ['multiPic', '图文卡片'],
]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
export function cardClipboardText(kind: string, values: readonly unknown[]): string {
  const lines = [
    ...new Set(
      values.map(text).filter((value) => value && !/^\[(?:卡片|分享|小程序|链接)\]$/.test(value)),
    ),
  ];
  return [`[${kind}]`, ...lines].join('\n');
}

/** 复用渲染器的语义槽位，只复制可读信息，不展开原始 JSON／缩略图票据。 */
export function arkClipboardText(raw: unknown, summary?: unknown): string {
  const data = parseArkData(raw);
  if (!record(data)) return cardClipboardText('ARK 卡片', [summary]);
  const app = text(data.app);
  const entries = Object.entries(record(data.meta) ? data.meta : {}).filter(
    (entry): entry is [string, Record<string, unknown>] => record(entry[1]),
  );
  const meta = Object.fromEntries(entries);
  const resolved = resolveArkCard(app, meta);
  const key =
    resolved.metaKey && Object.hasOwn(meta, resolved.metaKey)
      ? resolved.metaKey
      : (entries[0]?.[0] ?? text(data.view));
  const block = meta[key] ?? {};
  const group = groupShareTarget(app, meta);
  const values = resolved.values;
  const location = text(block.lat) && text(block.lng);
  const kind = group
    ? '群名片'
    : location
      ? '位置卡片'
      : (APP_TYPES.get(app) ?? META_TYPES.get(key) ?? `ARK 卡片${app ? ` · ${app}` : ''}`);
  if (app === 'com.tencent.mannounce') {
    const decode = (value: unknown) =>
      block.encode === 1 || block.encode === '1' ? decodeBase64Utf8(text(value)) : text(value);
    return cardClipboardText(kind, [decode(block.title), decode(block.text), data.prompt, summary]);
  }
  const preview = Array.isArray(block.news)
    ? block.news.flatMap((row) => (record(row) ? [row.text] : []))
    : [];
  return cardClipboardText(kind, [
    group?.name,
    group ? `群号：${group.code}` : '',
    values?.title || block.title || block.name || block.nickname,
    block.subTitle,
    values?.desc || block.desc || block.digest || block.address,
    values?.summary || block.summary,
    block.contentText || block.content || block.text,
    ...preview,
    values?.source || block.source || block.appName,
    values?.footerSource,
    location ? `坐标：${text(block.lat)}, ${text(block.lng)}` : '',
    values?.jump ||
      block.jumpUrl ||
      block.qqdocurl ||
      block.url ||
      block.mailUrl ||
      block.mailUrlByCode,
    data.prompt,
    summary,
  ]);
}
