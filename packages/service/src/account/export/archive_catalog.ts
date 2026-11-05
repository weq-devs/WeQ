import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { object } from './archive';
import { readArchiveHeader } from './archive_stream';
import type { ExportBaselineEntry } from './baseline';

export interface FormalArchiveEntry extends ExportBaselineEntry {
  formal: { path: string; format: 'json' | 'jsonl'; archiveId: string };
}
/** 有界探索；归档身份来自 header，不以文件名或目录名猜测会话。 */
export async function listFormalArchives(directory: string): Promise<FormalArchiveEntry[]> {
  const root = await realpath(directory),
    info = await lstat(root);
  const candidates: string[] = [];
  if (info.isFile()) candidates.push(root);
  else {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.slice(0, 512)) {
      if (entry.isFile() && /\.jsonl?$/i.test(entry.name)) candidates.push(join(root, entry.name));
      else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        for (const file of (await readdir(join(root, entry.name), { withFileTypes: true })).slice(
          0,
          128,
        ))
          if (file.isFile() && /\.jsonl?$/i.test(file.name))
            candidates.push(join(root, entry.name, file.name));
      }
    }
  }
  const found: FormalArchiveEntry[] = [];
  for (const path of candidates.slice(0, 512)) {
    for (const format of ['json', 'jsonl'] as const) {
      try {
        const header = await readArchiveHeader(path, format);
        const selection = object(object(object(header.scope).selection).value);
        if (typeof selection.kind !== 'string' || typeof selection.conv !== 'string') break;
        const info = await lstat(path),
          range = object(selection.range);
        found.push({
          directory: path,
          journalPath: path,
          name: basename(path),
          kind: selection.kind,
          conv: selection.conv,
          messageCount: null,
          formats: [format],
          range: {
            start: typeof range.start === 'number' ? range.start : null,
            end: typeof range.end === 'number' ? range.end : null,
          },
          updatedAt: info.mtimeMs,
          bytes: info.size,
          formal: { path, format, archiveId: String(header.archiveId) },
        });
        break;
      } catch {
        /* 旧格式继续由原目录识别器处理；真正续写时完整校验。 */
      }
    }
  }
  return found;
}

export async function resolveArchiveTargets(
  selected: string,
  conversation: { kind: string; conv: string },
  formats: string[],
): Promise<Partial<Record<'json' | 'jsonl', string>> | undefined> {
  const info = await lstat(selected);
  const entries = (await listFormalArchives(selected)).filter(
    (entry) => entry.kind === conversation.kind && entry.conv === conversation.conv,
  );
  if (!entries.length) return undefined;
  const ids = new Set(entries.map((entry) => entry.formal.archiveId));
  if (ids.size !== 1) throw new Error('找到多个相同会话的正式归档，请选择具体归档文件。');
  const siblings = info.isFile() ? await listFormalArchives(dirname(selected)) : entries;
  const result: Partial<Record<'json' | 'jsonl', string>> = {};
  for (const format of formats)
    if (format === 'json' || format === 'jsonl') {
      const matches = siblings.filter(
        (entry) =>
          entry.formal.archiveId === entries[0]!.formal.archiveId && entry.formal.format === format,
      );
      if (matches.length !== 1)
        throw new Error(`请明确选择已有 ${format.toUpperCase()} 归档；缺失或同格式有多个文件。`);
      result[format] = matches[0]!.formal.path;
    }
  if (!Object.keys(result).length) throw new Error('仅 JSON/JSONL 支持更新正式归档。');
  return result;
}
