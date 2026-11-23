import { pinyin, polyphonic } from 'pinyin-pro';

const HAN = /\p{Script=Han}/u;
const PINYIN_INPUT = /^[a-z]{2,}$/;
const ASCII_SYLLABLE = /^[a-z]+$/;
const SPELLING = { type: 'array', toneType: 'none', v: true } as const;
// 两档拼音分数均低于原文匹配。显示名补分也不跨档。
const COMMON_READING = 1.5;
const OTHER_READING = 1;
const DISPLAY_NAME_BONUS = 0.1;

function matchesInitials(
  parts: readonly (readonly string[])[],
  query: string,
  requireEveryReading = false,
): boolean {
  for (let start = 0; start + query.length <= parts.length; start++) {
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
    if (length === query.length) return true;
  }
  return false;
}

function matchesSpelling(parts: readonly (readonly string[])[], query: string): boolean {
  let offsets: number[] = [];
  let next: number[] = [];
  for (const readings of parts) {
    // 每个字都可以是起点。只保留上一字读完后的位置，并合并重复位置。
    offsets.push(0);
    for (const offset of offsets) {
      for (const reading of readings) {
        const remaining = query.length - offset;
        if (reading.length >= remaining) {
          if (reading.startsWith(query.slice(offset))) return true;
        } else if (query.startsWith(reading, offset) && !next.includes(offset + reading.length)) {
          next.push(offset + reading.length);
        }
      }
    }
    [offsets, next] = [next, offsets];
    next.length = 0;
  }
  return false;
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
    Array.from(name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ''), readingsFor);
  const testName = (name: string): boolean => {
    if (!HAN.test(name)) return false;
    const parts = spellingParts(name);
    return matchesInitials(parts, query) || matchesSpelling(parts, query);
  };
  const test = (...names: (string | null | undefined)[]): boolean =>
    names.some((name, index) => Boolean(name && names.indexOf(name) === index && testName(name)));
  const rankName = (name: string): number => {
    if (!HAN.test(name)) return 0;
    const readings = spellingParts(name);
    if (matchesInitials(readings, query, true)) return COMMON_READING;
    if (!matchesInitials(readings, query) && !matchesSpelling(readings, query)) return 0;
    if (readings.every((part) => part.length <= 1)) return COMMON_READING;
    const standard = pinyin(name.normalize('NFKC').toLowerCase(), {
      ...SPELLING,
      nonZh: 'spaced',
    });
    const parts = standard.flatMap((syllable) => {
      const clean = syllable.trim();
      if (!clean) return [];
      return [ASCII_SYLLABLE.test(clean) ? [clean] : []];
    });
    return matchesInitials(parts, query) || matchesSpelling(parts, query)
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
  return { test, rank, rankWithPreferredName };
}
