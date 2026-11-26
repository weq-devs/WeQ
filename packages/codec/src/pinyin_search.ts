import { pinyin, polyphonic } from 'pinyin-pro';

const HAN = /\p{Script=Han}/u;
const PINYIN_INPUT = /^[a-z\p{Script=Han}]{2,}$/u;
const ASCII_LETTER = /[a-z]/;
const ASCII_SYLLABLE = /^[a-z]+$/;
const SPELLING = { type: 'array', toneType: 'none', v: true } as const;
// 两档拼音分数均低于原文匹配。显示名补分也不跨档。
const COMMON_READING = 1.5;
const OTHER_READING = 1;
const DISPLAY_NAME_BONUS = 0.1;

type TextRange = readonly [start: number, end: number];
type NamePart = { spellings: readonly string[]; hasAlternateReadings?: boolean };

const normalizeName = (name: string) => name.normalize('NFKC').toLowerCase();

function spellingsFor(char: string, readings: readonly string[]): readonly string[] {
  const spellings = new Set([char]);
  for (const reading of readings) {
    spellings.add(reading);
    spellings.add(reading[0]!);
  }
  return [...spellings];
}

function findMatch(parts: readonly NamePart[], query: string, from = 0): TextRange | undefined {
  let match: TextRange | undefined;
  let offsets = new Map<number, number>();
  let next = new Map<number, number>();
  for (let index = from; index < parts.length; index++) {
    if (!match) offsets.set(0, index);
    for (const [offset, start] of offsets) {
      if (match && start > match[0]) continue;
      for (const spelling of parts[index]!.spellings) {
        const end = offset + spelling.length;
        if (end >= query.length) {
          // 只有末尾音节可以只输前几位。同起点取较长的原文，例如 sh 高亮「上海」。
          if (spelling.startsWith(query.slice(offset))) match = [start, index + 1];
        } else if (query.startsWith(spelling, offset) && start < (next.get(end) ?? Infinity)) {
          // 消耗相同查询前缀的路径只需保留最早的原文起点。
          next.set(end, start);
        }
      }
    }
    if (match && next.size === 0) break;
    [offsets, next] = [next, offsets];
    next.clear();
  }
  return match;
}

/** 同一名称内逐字匹配原文、全拼或首字母。 */
export function createPinyinMatcher(keyword: string) {
  const query = keyword
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ü/g, 'v')
    .replace(/[\s'’]+/gu, '');
  if (!PINYIN_INPUT.test(query) || !ASCII_LETTER.test(query)) return undefined;

  // 同一查询复用字典查找结果，逐字的全拼和首字母各只比较一次。
  const cachedParts = new Map<string, NamePart>();
  const getPart = (char: string): NamePart => {
    const known = cachedParts.get(char);
    if (known) return known;
    const readings = HAN.test(char)
      ? (polyphonic(char, SPELLING)[0] ?? []).filter((reading) => ASCII_SYLLABLE.test(reading))
      : [];
    const result = {
      spellings: spellingsFor(char, readings),
      hasAlternateReadings: readings.length > 1,
    };
    cachedParts.set(char, result);
    return result;
  };
  const nameParts = (name: string) => Array.from(name.replace(/\s+/gu, ''), getPart);
  const findRanges = (name: string): TextRange[] => {
    if (!HAN.test(name)) return [];
    const parts: NamePart[] = [];
    const positions: TextRange[] = [];
    for (const { 0: segment, index } of name.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
      for (const char of normalizeName(segment).replace(/\s+/gu, '')) {
        parts.push(getPart(char));
        positions.push([index, index + segment.length]);
      }
    }
    const ranges: TextRange[] = [];
    for (let from = 0; from < parts.length; ) {
      const match = findMatch(parts, query, from);
      if (!match) break;
      const [start, end] = match;
      const originalStart = positions[start]![0];
      const originalEnd = positions[end - 1]![1];
      if (originalStart >= (ranges.at(-1)?.[1] ?? 0)) ranges.push([originalStart, originalEnd]);
      from = end;
    }
    return ranges;
  };
  const testName = (name: string): boolean => {
    if (!HAN.test(name)) return false;
    return Boolean(findMatch(nameParts(normalizeName(name)), query));
  };
  const test = (...names: (string | null | undefined)[]): boolean =>
    names.some((name, index) => Boolean(name && names.indexOf(name) === index && testName(name)));
  const rankName = (name: string): number => {
    if (!HAN.test(name)) return 0;
    const normalized = normalizeName(name);
    const parts = nameParts(normalized);
    if (!findMatch(parts, query)) return 0;
    if (!parts.some((part) => part.hasAlternateReadings)) return COMMON_READING;
    const standard = pinyin(normalized, { ...SPELLING, type: 'all' }).flatMap((part) => {
      if (!part.origin.trim()) return [];
      const readings = part.isZh && ASCII_SYLLABLE.test(part.result) ? [part.result] : [];
      return [{ spellings: spellingsFor(part.origin, readings) }];
    });
    return findMatch(standard, query) ? COMMON_READING : OTHER_READING;
  };
  const rank = (...names: (string | null | undefined)[]): number => {
    let best = 0;
    for (const [index, name] of names.entries()) {
      if (!name || names.indexOf(name) !== index) continue;
      best = Math.max(best, rankName(name));
      if (best === COMMON_READING) return best;
    }
    return best;
  };
  const rankWithPreferredName = (
    preferred: string,
    ...otherNames: (string | null | undefined)[]
  ) => {
    const preferredRank = rankName(preferred);
    const score = preferredRank ? preferredRank + DISPLAY_NAME_BONUS : 0;
    if (preferredRank === COMMON_READING) return score;
    return Math.max(score, rank(...otherNames.filter((name) => name !== preferred)));
  };
  return { test, rank, rankWithPreferredName, findRanges };
}
