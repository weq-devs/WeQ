import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { normalizeMergeForwardDraft, type MergeForwardDraftInput } from '../merge_forward_drafts';
import { fileDigest } from './archive_resource';
import type { ResourceExportRunContext, ResourceExportSummary } from './task_manager';

/** 导出副本使用包内路径；不修改草稿或归档的本机路径。 */
export async function writeCompositionBundle(
  input: MergeForwardDraftInput,
  context: ResourceExportRunContext,
  authorize: (path: string) => Promise<boolean>,
  resolveMedia?: (
    segment: Record<string, unknown>,
    node: { time: number; sourceMsgId?: string },
    signal: AbortSignal,
  ) => Promise<string | null>,
): Promise<ResourceExportSummary> {
  const draft = normalizeMergeForwardDraft(structuredClone(input), input.id);
  if (!draft) throw new Error('合成记录无效');
  const references: Array<{ object: Record<string, unknown>; key: string; path: string }> = [];
  const failed: ResourceExportSummary['failed'] = [];
  async function visit(
    segs: unknown[],
    node: { time: number; sourceMsgId?: string },
    depth = 0,
  ): Promise<void> {
    if (depth > 16) throw new Error('合成嵌套过深');
    for (const raw of segs) {
      context.signal.throwIfAborted();
      if (!raw || typeof raw !== 'object') continue;
      const seg = raw as Record<string, unknown>;
      if (seg.t === 'node' && Array.isArray(seg.segs))
        await visit(
          seg.segs,
          {
            ...node,
            time: typeof seg.time === 'number' && Number.isFinite(seg.time) ? seg.time : node.time,
          },
          depth + 1,
        );
      if (['image', 'record', 'video', 'file'].includes(String(seg.t))) {
        const available =
          typeof seg.path === 'string' &&
          (await authorize(seg.path)) &&
          (await stat(seg.path).then(
            (info) => info.isFile(),
            () => false,
          ));
        if (!available && resolveMedia) {
          try {
            const path = await resolveMedia(seg, node, context.signal);
            if (path) seg.path = path;
          } catch (error) {
            context.signal.throwIfAborted();
            failed.push({
              fileName: String(seg.fileName || seg.id || '媒体'),
              error: error instanceof Error ? error.message : '媒体补全失败',
            });
            continue;
          }
        }
        if (!seg.path)
          failed.push({
            fileName: String(seg.fileName || seg.id || '媒体'),
            error: '媒体尚未取得本地文件',
          });
        for (const key of ['path', 'thumbPath'])
          if (typeof seg[key] === 'string' && seg[key])
            references.push({ object: seg, key, path: seg[key] });
      }
      if (
        seg.t === 'opaque' &&
        seg.element &&
        typeof seg.element === 'object' &&
        'type' in seg.element &&
        ['pic', 'ptt', 'video', 'file'].includes(String(seg.element.type))
      ) {
        let path: string | null = null;
        try {
          path = (await resolveMedia?.(seg, node, context.signal)) ?? null;
        } catch {
          context.signal.throwIfAborted();
        }
        if (path) references.push({ object: seg, key: 'exportPath', path });
        else
          failed.push({
            fileName: String(seg.id || '媒体'),
            error: '原始媒体补全失败或缺少可解析身份',
          });
      }
    }
  }
  for (const node of draft.nodes) await visit(node.segs, node);
  const resources: Array<{ path: string; sha256: string }> = [];
  const copied = new Map<string, string>();
  const hashes = new Map<string, string>();
  const unresolved = failed.length;
  await mkdir(join(context.directory, 'media'), { recursive: true });
  for (const [index, ref] of references.entries()) {
    context.signal.throwIfAborted();
    let partial: string | undefined;
    try {
      let output = copied.get(ref.path);
      if (!output) {
        if (!(await authorize(ref.path))) throw new Error('媒体文件不可读取');
        const digest = await fileDigest(ref.path, context.signal);
        context.signal.throwIfAborted();
        output = `media/${digest.sha256}${extname(ref.path).match(/^\.[\da-z]{1,12}$/i)?.[0] ?? ''}`;
        if (!hashes.has(digest.sha256)) {
          const target = join(context.directory, output);
          let existing: Awaited<ReturnType<typeof fileDigest>> | undefined;
          try {
            existing = await fileDigest(target, context.signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (!existing) {
            partial = `${target}.${randomUUID()}.part`;
            await pipeline(
              createReadStream(ref.path),
              createWriteStream(partial, { flags: 'wx' }),
              { signal: context.signal },
            );
          }
          const saved = existing ?? (await fileDigest(partial!, context.signal));
          if (saved.sha256 !== digest.sha256 || saved.size !== digest.size)
            throw new Error('媒体在复制期间发生变化');
          if (partial) {
            await link(partial, target);
            await rm(partial);
          }
          hashes.set(digest.sha256, output);
          resources.push({ path: output, sha256: digest.sha256 });
          partial = undefined;
        } else output = hashes.get(digest.sha256)!;
        copied.set(ref.path, output);
      }
      ref.object[ref.key] = output;
    } catch (error) {
      if (partial) await rm(partial, { force: true });
      delete ref.object[ref.key];
      context.signal.throwIfAborted();
      failed.push({
        fileName: basename(ref.path),
        error: error instanceof Error ? error.message : '媒体保存失败',
      });
    }
    context.progress(index + 1, references.length);
  }
  context.signal.throwIfAborted();
  await writeFile(
    join(context.directory, 'composition.json'),
    JSON.stringify(
      {
        format: 'weq-composition',
        version: 2,
        origin: 'local-composition',
        media: 'relative-path-references',
        draft,
        resources,
        complete: failed.length === 0,
        missing: failed,
      },
      null,
      2,
    ),
  );
  const total = references.length + 1 + unresolved;
  return { total, ok: total - failed.length, failed };
}
