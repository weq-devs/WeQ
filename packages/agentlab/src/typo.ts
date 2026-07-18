/**
 * 轻量「人味」后处理：去掉 LLM 回复里过分工整的痕迹，偶尔制造真人手滑的同音错别字。
 * 借鉴 MaiBot `typo_generator`，但不依赖 pypinyin/jieba——用一份手挑的常见同音/形近混淆组，
 * 低概率替换 1~2 个字，并偶尔吃掉句尾句号，足够把「AI 感」削下来又不至于读不通。
 */

/** 常见同音 / 形近混淆组：真人手滑时会写错成同组里的另一个字。 */
const CONFUSION_GROUPS: string[][] = [
  ['在', '再'],
  ['的', '得', '地'],
  ['他', '她', '它'],
  ['做', '作'],
  ['那', '哪'],
  ['吗', '嘛'],
  ['以', '已'],
  ['是', '事'],
  ['想', '像'],
  ['到', '道'],
  ['和', '合'],
  ['有', '友'],
  ['知', '织'],
  ['听', '挺'],
  ['还', '换'],
  ['觉', '决'],
  ['号', '好'],
  ['这', '折'],
];

/** 字 → 同组其它字。 */
const CONFUSION_MAP = new Map<string, string[]>();
for (const group of CONFUSION_GROUPS) {
  for (const ch of group) {
    CONFUSION_MAP.set(ch, group.filter((other) => other !== ch));
  }
}

/** 默认强度：约 10% 的消息会带一处手滑。0 关闭。 */
export const DEFAULT_TYPO_INTENSITY = 0.1;

/**
 * 用一个确定性 PRNG（不依赖 Math.random，便于复现/测试）。seed 取文本内容即可，
 * 同一条回复每次处理结果一致，不会让用户看着「刷新就变」。
 */
function makeRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 给一条短消息注入至多一处同音错别字（很短的消息不动，避免破坏关键词）。
 * intensity ∈ [0,1]：越高越容易手滑。返回处理后的文本。
 */
export function humanizeText(text: string, intensity = DEFAULT_TYPO_INTENSITY): string {
  const trimmed = text.trim();
  if (intensity <= 0 || trimmed.length < 6) return text;
  const rng = makeRng(trimmed);

  let out = text;

  // 1) 同音字手滑：找出所有可替换位置，按强度决定动不动手，命中则随机挑一处替换。
  if (rng() < intensity) {
    const positions: number[] = [];
    for (let i = 0; i < out.length; i += 1) {
      if (CONFUSION_MAP.has(out[i]!)) positions.push(i);
    }
    if (positions.length > 0) {
      const pos = positions[Math.floor(rng() * positions.length)]!;
      const alts = CONFUSION_MAP.get(out[pos]!)!;
      const alt = alts[Math.floor(rng() * alts.length)]!;
      out = out.slice(0, pos) + alt + out.slice(pos + 1);
    }
  }

  // 2) 偶尔吃掉句尾的句号（真人短消息很少打结尾句号）。
  if (rng() < intensity * 0.6 && /[。.]$/.test(out)) {
    out = out.replace(/[。.]$/, '');
  }

  return out;
}
