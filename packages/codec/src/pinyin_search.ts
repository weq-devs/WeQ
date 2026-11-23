import { pinyin, polyphonic } from 'pinyin-pro';

const HAN = /\p{Script=Han}/u;
const PINYIN_INPUT = /^[a-z]{2,}$/;
const ASCII_SYLLABLE = /^[a-z]+$/;
const SPELLING = { type: 'array', toneType: 'none', v: true } as const;
// 两档拼音分数均低于原文匹配。显示名补分也不跨档。
const COMMON_READING = 1.5;
const OTHER_READING = 1;
const DISPLAY_NAME_BONUS = 0.1;

type TextRange = readonly [start: number, end: number];

const normalizeName = (name: string) => name.normalize('NFKC').toLowerCase();

function findInitials(
  parts: readonly (readonly string[])[],
  query: string,
  requireEveryReading = false,
  from = 0,
): number {
  for (let start = from; start + query.length <= parts.length; start++) {
    let length = 0;
    while (length < query.length) {
      const readings = parts[start + length]!;
      const letter = query[length];
      const matches = requireEveryReading
        ? readings.length > 0 && readings.every((reading) => reading[0] === letter)
        : readings.some((reading) => reading[0] === letter);
      if (!matches) break;
      length++;
    }
    if (length === query.length) return start;
  }
  return -1;
}

function findSpelling(
  parts: readonly (readonly string[])[],
  query: string,
  from = 0,
  until = parts.length,
): TextRange | undefined {
  if (from >= until) return undefined;
  let offsets = new Map<number, number>();
  let next = new Map<number, number>();
  for (let index = from; index < until; index++) {
    // 每个字都可以是起点。对已读完的查询前缀保留一个原文起点。
    offsets.set(0, index);
    for (const [offset, start] of offsets) {
      for (const reading of parts[index]!) {
        const remaining = query.length - offset;
        if (reading.length >= remaining) {
          if (reading.startsWith(query.slice(offset))) return [start, index + 1];
        } else if (query.startsWith(reading, offset) && !next.has(offset + reading.length)) {
          next.set(offset + reading.length, start);
        }
      }
    }
    [offsets, next] = [next, offsets];
    next.clear();
  }
  return undefined;
}

/** Match consecutive syllables using letters or full spelling, including alternate readings. */
export function createPinyinMatcher(keyword: string) {
  const query = keyword
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ü/g, 'v')
    .replace(/[\s'’]+/gu, '');
  if (!PINYIN_INPUT.test(query)) return undefined;

  // 同一查询复用字典查找结果，名称或查询变化时直接根据当前输入匹配。
  const readings = new Map<string, readonly string[]>();
  const readingsFor = (char: string): readonly string[] => {
    const known = readings.get(char);
    if (known) return known;
    const result = HAN.test(char)
      ? (polyphonic(char, SPELLING)[0] ?? []).filter((reading) => ASCII_SYLLABLE.test(reading))
      : ASCII_SYLLABLE.test(char)
        ? [char]
        : [];
    readings.set(char, result);
    return result;
  };
  const spellingParts = (name: string) =>
    Array.from(normalizeName(name).replace(/\s+/gu, ''), readingsFor);
  const findRanges = (name: string): TextRange[] => {
    if (!HAN.test(name)) return [];
    const parts: (readonly string[])[] = [];
    const positions: TextRange[] = [];
    for (const { 0: segment, index } of name.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
      for (const char of normalizeName(segment).replace(/\s+/gu, '')) {
        parts.push(readingsFor(char));
        positions.push([index, index + segment.length]);
      }
    }
    const ranges: TextRange[] = [];
    for (let from = 0; from < parts.length; ) {
      const initial = findInitials(parts, query, false, from);
      // 首字母命中优先，避免例如 sh 只标出「上海」的「上」。
      const match =
        findSpelling(parts, query, from, initial < 0 ? parts.length : initial) ??
        (initial < 0 ? undefined : ([initial, initial + query.length] as const));
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
    const parts = spellingParts(name);
    return findInitials(parts, query) >= 0 || Boolean(findSpelling(parts, query));
  };
  const test = (...names: (string | null | undefined)[]): boolean =>
    names.some((name, index) => Boolean(name && names.indexOf(name) === index && testName(name)));
  const rankName = (name: string): number => {
    if (!HAN.test(name)) return 0;
    const readings = spellingParts(name);
    if (findInitials(readings, query, true) >= 0) return COMMON_READING;
    if (findInitials(readings, query) < 0 && !findSpelling(readings, query)) return 0;
    if (readings.every((part) => part.length <= 1)) return COMMON_READING;
    const standard = pinyin(normalizeName(name), {
      ...SPELLING,
      nonZh: 'spaced',
    });
    const parts = standard.flatMap((syllable) => {
      const clean = syllable.trim();
      if (!clean) return [];
      return [ASCII_SYLLABLE.test(clean) ? [clean] : []];
    });
    return findInitials(parts, query) >= 0 || findSpelling(parts, query)
      ? COMMON_READING
      : OTHER_READING;
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
