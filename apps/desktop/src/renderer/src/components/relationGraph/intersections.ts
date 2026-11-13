/** 精确集合交集：稀疏时走倒排表，密集时按 32 位位集批量计数。 */
export function forEachIntersection<T>(
  rows: readonly (readonly T[])[],
  minimum: number,
  visit: (a: number, b: number, weight: number) => void,
): void {
  const postings = new Map<T, number[]>();
  const unique = rows.map((row) => [...new Set(row)]);
  for (let i = 0; i < unique.length; i++) {
    if (unique[i]!.length < minimum) continue;
    for (const value of unique[i]!) {
      const list = postings.get(value);
      if (list) list.push(i);
      else postings.set(value, [i]);
    }
  }
  const words = Math.ceil(postings.size / 32);
  let sparseWork = 0;
  for (const list of postings.values()) sparseWork += (list.length * (list.length - 1)) / 2;
  if (sparseWork === 0) return;
  const denseWork = ((rows.length * (rows.length - 1)) / 2) * words;
  // 位集只在能减少运算且内存有界时分配；大量独有群不会撑大密集矩阵。
  if (words && denseWork < sparseWork && rows.length * words <= 4_000_000) {
    const bits = new Uint32Array(rows.length * words);
    let feature = 0;
    for (const list of postings.values()) {
      const word = feature >>> 5;
      const mask = 1 << (feature & 31);
      for (const i of list) bits[i * words + word] = bits[i * words + word]! | mask;
      feature++;
    }
    for (let i = 0; i < rows.length; i++) {
      if (unique[i]!.length < minimum) continue;
      for (let j = i + 1; j < rows.length; j++) {
        if (unique[j]!.length < minimum) continue;
        let weight = 0;
        for (let w = 0; w < words; w++) {
          let value = bits[i * words + w]! & bits[j * words + w]!;
          value -= (value >>> 1) & 0x55555555;
          value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
          weight += (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
        }
        if (weight >= minimum) visit(i, j, weight);
      }
    }
    return;
  }

  // 至少重合 t 项的集合，按统一稀有度顺序取前 |集合|-t+1 项必有交集。
  // 大群里的成员各有独有群时，用此前缀排除「仅同一个大群」的海量无效候选。
  if (minimum > 1 && sparseWork > rows.length * 8) {
    const rank = new Map([...postings.keys()].map((value, i) => [value, i]));
    const prefixes = unique.map((row) =>
      row.length < minimum
        ? []
        : [...row]
            .sort(
              (a, b) =>
                postings.get(a)!.length - postings.get(b)!.length || rank.get(a)! - rank.get(b)!,
            )
            .slice(0, row.length - minimum + 1),
    );
    const prefixIndex = new Map<T, number[]>();
    let prefixWork = 0;
    let maxLength = 0;
    prefixes.forEach((prefix, i) => {
      maxLength = Math.max(maxLength, unique[i]!.length);
      for (const value of prefix) {
        const list = prefixIndex.get(value);
        if (list) {
          prefixWork += list.length;
          list.push(i);
        } else prefixIndex.set(value, [i]);
      }
    });
    if (prefixWork * maxLength < sparseWork) {
      const seen = new Int32Array(rows.length).fill(-1);
      const sets: Array<Set<T> | undefined> = [];
      for (let i = 0; i < rows.length; i++) {
        const candidates: number[] = [];
        for (const value of prefixes[i]!) {
          for (const j of prefixIndex.get(value)!) {
            if (j <= i || seen[j] === i) continue;
            seen[j] = i;
            candidates.push(j);
          }
        }
        candidates.sort((a, b) => a - b);
        for (const j of candidates) {
          const [small, big] = unique[i]!.length < unique[j]!.length ? [i, j] : [j, i];
          sets[big] ??= new Set(unique[big]!);
          let weight = 0;
          for (const value of unique[small]!) if (sets[big]!.has(value)) weight++;
          if (weight >= minimum) visit(i, j, weight);
        }
      }
      return;
    }
  }

  // 每行复用计数器，只访问实际共现的候选，不创建 O(N²) 的群对字符串 Map。
  const counts = new Uint32Array(rows.length);
  const touched: number[] = [];
  for (let i = 0; i < unique.length; i++) {
    if (unique[i]!.length < minimum) continue;
    for (const value of unique[i]!) {
      const list = postings.get(value)!;
      // 倒排表按行号递增，仅枚举后面的行，避免重复计数。
      let low = 0;
      let high = list.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (list[mid]! <= i) low = mid + 1;
        else high = mid;
      }
      for (let k = low; k < list.length; k++) {
        const j = list[k]!;
        if (counts[j] === 0) touched.push(j);
        counts[j] = counts[j]! + 1;
      }
    }
    touched.sort((a, b) => a - b);
    for (const j of touched) {
      if (counts[j]! >= minimum) visit(i, j, counts[j]!);
      counts[j] = 0;
    }
    touched.length = 0;
  }
}
