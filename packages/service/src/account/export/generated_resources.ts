import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import type { GeneratedContentSnapshot } from '../generated_content';
import { sanitizeSegment } from '../../common/path_sanitize';
import { inventoryExportOutput, saveExportOutput } from './save_output';

export interface GeneratedResourceReference {
  key: string;
  kind: 'voice' | 'sticker' | 'artifact';
  id: string;
  ownerId?: string;
  artifactKind?: 'html' | 'markdown' | 'text' | 'export';
  name: string;
  messageIds: string[];
}
export interface GeneratedResourceSource {
  filePath?: string;
  bundleDir?: string;
  reportPath?: string;
}
export interface GeneratedResourceCache {
  reference: GeneratedResourceReference;
  snapshot?: {
    directory: string;
    entry?: string;
    capturedAt: number;
    inventory: Array<[string, string]>;
  };
}
export interface GeneratedResourceManifest {
  schema: 'weq-generated-resources/1';
  /** 仅覆盖持久标记与附件句柄；文件正文保持原样，不隐式抓取 HTML/Markdown 外链。 */
  scope: 'known-generated-assets';
  integrityEncoding: 'bytes:sha256';
  complete: boolean;
  entries: Array<
    GeneratedResourceReference & {
      status: 'copied' | 'missing';
      path?: string;
      capturedAt?: number;
      files?: Array<{ path: string; integrity: string }>;
      error?: string;
    }
  >;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 只遍历已有的标记/附件契约，不递归猜测工具返回值或正文里的本机路径。 */
export function discoverGeneratedResources(
  snapshot: GeneratedContentSnapshot,
): GeneratedResourceReference[] {
  const refs = new Map<string, GeneratedResourceReference>();
  function add(value: Omit<GeneratedResourceReference, 'key' | 'messageIds'>, messageId: string) {
    const key = createHash('sha256')
      .update(
        JSON.stringify([value.kind, value.ownerId ?? null, value.id, value.artifactKind ?? null]),
      )
      .digest('hex');
    const existing = refs.get(key);
    if (existing) {
      if (!existing.messageIds.includes(messageId)) existing.messageIds.push(messageId);
    } else refs.set(key, { ...value, key, messageIds: [messageId] });
  }
  for (const message of snapshot.messages) {
    if (snapshot.target.kind !== 'assistant') {
      const ownerId =
        snapshot.target.kind === 'persona' ? snapshot.target.ownerId : message.senderId;
      for (const match of message.text.matchAll(/\[\[(sticker|voice):([0-9a-zA-Z._-]+)\]\]/g)) {
        const kind = match[1] as 'voice' | 'sticker',
          id = match[2]!;
        if (kind === 'sticker' && !/^[0-9a-fA-F]+$/.test(id)) continue;
        add({ kind, id, ...(kind === 'sticker' ? { ownerId } : {}), name: id }, message.id);
      }
    } else
      for (const step of message.steps ?? []) {
        const value = record(step);
        const artifact = value?.kind === 'artifact' ? record(value.artifact) : null;
        if (!artifact || typeof artifact.id !== 'string' || !artifact.id) continue;
        const kind = artifact.kind;
        if (kind !== 'html' && kind !== 'markdown' && kind !== 'text' && kind !== 'export')
          continue;
        add(
          {
            kind: 'artifact',
            id: artifact.id,
            artifactKind: kind,
            name: typeof artifact.name === 'string' ? artifact.name : artifact.id,
          },
          message.id,
        );
      }
  }
  return [...refs.values()];
}

export interface GeneratedResourceServices {
  agentLab: {
    getAgentVoicePath(id: string): string | null;
    getStickerPath(ownerId: string, md5: string): string | null;
  };
  assistant: { artifactInfo(id: string): { path: string } };
  exportManager: {
    getTask(
      id: string,
    ):
      | { status: string; filePath?: string; bundleDir?: string; reportPath?: string }
      | null
      | undefined;
  };
}

export function resolveGeneratedResource(
  ref: GeneratedResourceReference,
  services: GeneratedResourceServices,
): GeneratedResourceSource | null {
  if (ref.kind === 'voice') {
    const filePath = services.agentLab.getAgentVoicePath(ref.id);
    return filePath ? { filePath } : null;
  }
  if (ref.kind === 'sticker') {
    const filePath = ref.ownerId ? services.agentLab.getStickerPath(ref.ownerId, ref.id) : null;
    return filePath ? { filePath } : null;
  }
  if (ref.artifactKind !== 'export')
    return { filePath: services.assistant.artifactInfo(ref.id).path };
  const task = services.exportManager.getTask(ref.id);
  return task?.status === 'completed' && (task.bundleDir || task.filePath)
    ? { filePath: task.filePath, bundleDir: task.bundleDir, reportPath: task.reportPath }
    : null;
}

/** 已复制的资源有独立校验快照；恢复只读该快照，不再次查原会话或调用模型。 */
export async function bundleGeneratedResources(options: {
  cache: GeneratedResourceCache[];
  privateDirectory: string;
  outputDirectory: string;
  resolve?: (
    ref: GeneratedResourceReference,
  ) => GeneratedResourceSource | null | Promise<GeneratedResourceSource | null>;
  signal: AbortSignal;
  checkpoint: (current: number) => void;
}): Promise<{ manifest: GeneratedResourceManifest; published: Map<string, string> }> {
  const manifest: GeneratedResourceManifest = {
    schema: 'weq-generated-resources/1',
    scope: 'known-generated-assets',
    integrityEncoding: 'bytes:sha256',
    complete: true,
    entries: [],
  };
  const published = new Map<string, string>();
  for (const [index, item] of options.cache.entries()) {
    options.signal.throwIfAborted();
    const ref = item.reference;
    try {
      if (!item.snapshot) {
        const source = await options.resolve?.(ref);
        if (!source || !(source.bundleDir || source.filePath))
          throw new Error('本地资源不存在或当前数据源无法解析。');
        const name = sanitizeSegment(basename(ref.name, extname(ref.name)), ref.key);
        const directory = await saveExportOutput(
          { name, ...source },
          options.privateDirectory,
          options.signal,
        );
        item.snapshot = {
          directory,
          entry: source.bundleDir ? undefined : `${name}${extname(source.filePath!)}`,
          capturedAt: Date.now(),
          inventory: [...(await inventoryExportOutput(directory, options.signal))],
        };
        options.checkpoint(index);
      }
      options.signal.throwIfAborted();
      const captured = item.snapshot;
      const current = await inventoryExportOutput(captured.directory, options.signal);
      if (
        current.size !== captured.inventory.length ||
        captured.inventory.some(([path, hash]) => current.get(path) !== hash)
      )
        throw new Error('已保存资源快照校验失败；未回读原件替换。');
      const directory = await saveExportOutput(
        { name: ref.key, bundleDir: captured.directory },
        join(options.outputDirectory, 'resources'),
        options.signal,
      );
      const relativeRoot = `resources/${basename(directory)}`;
      manifest.entries.push({
        ...ref,
        status: 'copied',
        capturedAt: captured.capturedAt,
        path: `${relativeRoot}${captured.entry ? `/${captured.entry}` : ''}`,
        files: captured.inventory
          .filter(([, hash]) => hash !== 'directory')
          .map(([path, integrity]) => ({
            path: `${relativeRoot}/${path.replaceAll('\\', '/')}`,
            integrity,
          })),
      });
      published.set(ref.key, relativeRoot);
    } catch (error) {
      options.signal.throwIfAborted();
      manifest.complete = false;
      const message = error instanceof Error ? error.message : '';
      manifest.entries.push({
        ...ref,
        status: 'missing',
        error:
          message === '本地资源不存在或当前数据源无法解析。' ||
          message === '已保存资源快照校验失败；未回读原件替换。'
            ? message
            : '资源读取或复制失败，请检查本地资源与剩余空间。',
      });
    }
    options.checkpoint(index + 1);
  }
  return { manifest, published };
}
