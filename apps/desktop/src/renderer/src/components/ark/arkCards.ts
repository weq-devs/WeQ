/**
 * ARK 卡片语义解析层：把「app + meta」解析成布局类型 + 语义槽位值。
 *
 * 数据来源 `ark-cards.generated.json` 由 `scripts/extract-ark-cards.mjs` 从 QQ 官方
 * ark 资源包机械提取（每个 app 的 metaKey→字段绑定 + 自动语义槽位）。这里在其上叠加
 * 少量人工策展（布局归类 + 标准字段兜底），产出渲染器直接消费的 `ArkValues`。
 *
 * 设计要点：布局归类不进 JSON（保持“提取数据”与“人工策展”分离）。单一用途 app 用
 * `APP_LAYOUT` 直接钉布局；多模板分享 app（structmsg/troopsharecard/...）按 metaKey
 * （变体名）经 `METAKEY_LAYOUT` 推断。都命不中 → generic（仍带槽位值，优于纯猜）。
 */

import generated from './ark-cards.generated.json';

export type LayoutKind = 'contact' | 'news' | 'appBlock' | 'mediaBlock' | 'generic';

interface GenVariant {
  jump: string | null;
  slots: Record<string, string>;
  bindings: Record<string, string>;
}
interface GenEntry {
  defaultMetaKey: string;
  variants: Record<string, GenVariant>;
}
const GENERATED = generated as unknown as Record<string, GenEntry>;

/** 语义槽位值：渲染布局组件直接读这些字段（已是可显示的字符串/URL）。 */
export interface ArkValues {
  title?: string;
  desc?: string;
  summary?: string;
  thumb?: string; // 小方缩略图
  cover?: string; // 通栏大图
  name?: string;
  avatar?: string;
  source?: string; // 顶部/主来源标签文字
  sourceIcon?: string;
  footerSource?: string; // 底部来源标签（部分卡片顶/底各有一个来源）
  footerIcon?: string;
  button?: string;
  jump?: string;
}

export interface ResolvedArk {
  layout: LayoutKind;
  values: ArkValues | null;
  metaKey: string | null;
}

/** 单一用途 app：直接钉布局（覆盖 metaKey 推断）。 */
const APP_LAYOUT: Record<string, LayoutKind> = {
  'com.tencent.miniapp.lua': 'appBlock',
  'com.tencent.contact.lua': 'contact',
  'com.tencent.mobileqq.cardshare': 'contact',
  'com.tencent.music.lua': 'news',
  'com.tencent.tuwen.lua': 'news',
  'com.tencent.together': 'mediaBlock',
};

/** 多模板分享 app：按 metaKey（变体名）决定布局。 */
const METAKEY_LAYOUT: Record<string, LayoutKind> = {
  news: 'news',
  music: 'news',
  video: 'news',
  messages: 'news',
  pic: 'news',
  contact: 'contact',
  transfercontact: 'contact',
  miniapp: 'appBlock',
  invite: 'mediaBlock',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 解析一张 ark 卡：选 metaKey → 按槽位取值 → 标准字段兜底 → 定布局。
 * @param app   arkData.app
 * @param meta  arkData.meta（metaKey → 字段块）
 */
export function resolveArkCard(app: string, meta: Record<string, Record<string, unknown>>): ResolvedArk {
  const metaKeys = Object.keys(meta ?? {});
  const entry = GENERATED[app];
  if (!entry) return { layout: 'generic', values: null, metaKey: metaKeys[0] ?? null };

  // 选 metaKey：优先 payload 里实际出现、且我们有对应变体的那个；否则默认变体。
  const metaKey =
    metaKeys.find((k) => entry.variants[k]) ??
    (entry.variants[entry.defaultMetaKey] ? entry.defaultMetaKey : metaKeys[0]);
  const variant = metaKey ? entry.variants[metaKey] : undefined;
  const block = metaKey ? meta[metaKey] : undefined;
  if (!variant || !block) return { layout: 'generic', values: null, metaKey: metaKey ?? null };

  const values: ArkValues = {};
  const v = values as Record<string, string>;
  for (const [slot, field] of Object.entries(variant.slots)) {
    const val = str(block[field]);
    if (val) v[slot] = val;
  }

  const layout = APP_LAYOUT[app] ?? (metaKey ? METAKEY_LAYOUT[metaKey] : undefined) ?? 'generic';

  // 标准字段兜底：槽位没覆盖到的，用 QQ 通用字段名补齐（各卡字段名高度一致）。
  const s = (f: string): string => str(block[f]);
  const fill = (slot: keyof ArkValues, ...fields: string[]): void => {
    if (values[slot]) return;
    for (const f of fields) {
      const got = s(f);
      if (got) {
        v[slot] = got;
        return;
      }
    }
  };
  fill('title', 'title');
  fill('desc', 'desc', 'digest', 'contactInfo', 'contact', 'address');
  fill('summary', 'summary');
  fill('name', 'nickname');
  fill('avatar', 'avatar');
  fill('source', 'source', 'tag');
  fill('sourceIcon', 'sourcelogo', 'tagIcon', 'icon');
  fill('button', 'button');
  fill('jump', 'jumpUrl', 'qqdocurl', 'url');
  // 大图/小图兜底：miniapp（说说分享等）的大图字段名是 preview，未进机器生成的槽位表，
  // 这里补进 cover/thumb，否则 AppBlockCard 的 big 取不到值、preview 不渲染。
  fill('cover', 'cover', 'preview');
  fill('thumb', 'thumb');

  // 部分卡片顶/底各有一个来源标签（如小程序：顶=source、底=tag「QQ小程序」）。
  if (layout === 'appBlock') {
    values.footerSource = s('tag');
    values.footerIcon = s('tagIcon');
  }

  return { layout, values, metaKey: metaKey ?? null };
}
