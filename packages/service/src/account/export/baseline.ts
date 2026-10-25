import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

export interface ExportBaselineEntry {
  directory: string;
  journalPath: string;
  name: string;
  kind: string;
  conv: string;
  messageCount: number | null;
  formats: string[];
  range: { start: number | null; end: number | null } | null;
  updatedAt: number;
  bytes: number;
}
const dateField = (value: unknown, seconds = false): number | null =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= (seconds ? 8640000000000 : 8640000000000000)
    ? value
    : null;

/** 只读取导出清单和文件大小，不加载正文；目录探索有界且不跟随子目录链接。 */
export function listExportBaselines(directory: string) {
  if (!isAbsolute(directory)) throw new Error('增量基线必须是绝对路径。');
  const root = realpathSync(directory);
  if (!lstatSync(root).isDirectory()) throw new Error('增量基线必须是文件夹。');
  const candidates = [root, join(root, '.weq-export')];
  const directories = readdirSync(root, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  for (const entry of directories.slice(0, 512)) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    candidates.push(path, join(path, '.weq-export'));
  }
  const found: ExportBaselineEntry[] = [];
  for (const directory of new Set(candidates)) {
    const manifest = join(directory, 'baseline.json');
    if (!existsSync(directory) || !lstatSync(directory).isDirectory() || !existsSync(manifest))
      continue;
    const info = lstatSync(manifest);
    if (!info.isFile() || info.size > 65536) continue;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const data = value as Record<string, unknown>;
    if (typeof data.selection !== 'string' || !/^[a-f0-9]{64}$/.test(data.selection)) continue;
    const name = `messages-${data.selection}.jsonl`;
    if (
      data.version !== 1 ||
      typeof data.kind !== 'string' ||
      typeof data.conv !== 'string' ||
      data.journal !== name
    )
      continue;
    const path = join(directory, basename(name));
    if (existsSync(path) && lstatSync(path).isFile()) {
      const range =
        data.range && typeof data.range === 'object'
          ? (data.range as Record<string, unknown>)
          : null;
      found.push({
        directory,
        journalPath: path,
        name: typeof data.name === 'string' ? data.name : data.conv,
        kind: data.kind,
        conv: data.conv,
        messageCount:
          typeof data.messageCount === 'number' &&
          Number.isSafeInteger(data.messageCount) &&
          data.messageCount >= 0
            ? data.messageCount
            : null,
        formats: Array.isArray(data.formats)
          ? data.formats.filter((value): value is string => typeof value === 'string')
          : [],
        range: range
          ? {
              start: dateField(range.start, true),
              end: dateField(range.end, true),
            }
          : null,
        updatedAt: dateField(data.updatedAt) ?? 0,
        bytes: lstatSync(path).size,
      });
    }
  }
  found.sort((a, b) => b.updatedAt - a.updatedAt);
  return { items: found, truncated: directories.length > 512 };
}

export function findExportBaseline(
  directory: string,
  conversation: { kind: string; conv: string },
): string {
  const result = listExportBaselines(directory);
  const found = result.items.filter(
    (entry) => entry.kind === conversation.kind && entry.conv === conversation.conv,
  );
  if (found.length > 1)
    throw new Error(`找到 ${found.length} 个相同会话的基线，请选择具体导出文件夹。`);
  if (result.truncated) throw new Error('未列出所有导出目录，请选择更具体的文件夹。');
  if (!found[0])
    throw new Error('所选文件夹没有与当前会话匹配的增量基线，请新建导出或选择其他文件夹。');
  return found[0].journalPath;
}
