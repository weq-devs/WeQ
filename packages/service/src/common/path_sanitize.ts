/**
 * 路径段清洗 + 文件名去重的唯一实现。
 *
 * 以前各模块各写一份、行为逐步漂移（替换字符 `_` vs 空格、80 vs 120 长度上限、
 * Windows 保留名处理、uniqueName 是否保留扩展名…），下载落盘 / 导出目录两处会得到
 * 不同的文件名。这里统一语义，行为取「更稳健」的那份：
 *   - 非法路径字符与 **控制字符** 一律替换成 `_`（空白的折叠仍保留：可读性优先）；
 *   - 去掉首尾空白与尾部 `.`/空格；
 *   - 达到 maxLen 截断（导出文件名默认 80；闪传传 120）；
 *   - Windows 保留设备名（con/nul/com1…）不单独使用，回退 `fallback`；
 *   - `uniqueName` 保留扩展名去重：`a.gif` 冲突后依次 `a-2.gif`、`a-3.gif`…
 *
 * 注意：`apps/desktop/src/main/mcp/external.ts` 里那个 `sanitizeSegment` 是**标识符**
 * 清洗（只留 `[A-Za-z0-9_-]` 生成工具命名空间），跟这里的文件系统路径清洗不是一回事，
 * 刻意没有合并进来。
 */

import { extname } from 'node:path';

/** Windows 保留设备名（不区分大小写），单独作段名会导致创建失败。 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/** {@link sanitizeSegment} 的选项。 */
export interface SanitizeSegmentOpts {
  /** 最大长度（UTF-16 code unit）。默认 80。 */
  maxLen?: number;
}

/**
 * 把任意文本清洗成跨平台安全的单个路径段：剥非法字符 / 控制符 → `_`，折叠空白，
 * 去首尾点/空格，截到 maxLen，空 / 保留名回退到 `fallback`。永不返回空串。
 */
export function sanitizeSegment(
  value: string | undefined,
  fallback: string,
  opts: SanitizeSegmentOpts = {},
): string {
  const maxLen = opts.maxLen ?? 80;
  const cleaned = (value ?? '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 剔除文件名控制字符
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .slice(0, maxLen)
    .trim();
  if (!cleaned || RESERVED_NAMES.has(cleaned.toLowerCase())) return fallback;
  return cleaned;
}

/**
 * 在 `used` 集合内去重（大小写不敏感）：冲突时保留扩展名、在主干后追加 `-2` / `-3`…
 * 例如 `a.gif` 已被占用 → `a-2.gif`。已占用会登记进集合，返回的新名不会再撞。
 */
export function uniqueName(name: string, used: Set<string>): string {
  const key = name.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return name;
  }
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i += 1) {
    const next = `${stem}-${i}${ext}`;
    const nextKey = next.toLowerCase();
    if (!used.has(nextKey)) {
      used.add(nextKey);
      return next;
    }
  }
}

/** 把相对路径按 `/` 拆段逐段清洗（防目录穿越 + 非法字符）。 */
export function safeRelSegments(relPath: string, opts?: SanitizeSegmentOpts): string[] {
  return relPath
    .split('/')
    .map((seg) => sanitizeSegment(seg, 'file', opts))
    .filter(Boolean);
}
