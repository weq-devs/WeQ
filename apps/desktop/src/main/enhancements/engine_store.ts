import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { link, lstat, mkdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { x as extract } from 'tar';
import { ManagedDownload } from '@weq/service/managed-download';
import { enhancementEngineBusy } from './engine_environment';
import {
  enhancementEngineCompatibility,
  ENHANCEMENT_ENGINE_RECIPES,
  parseEnhancementEngineManifest,
  safeEnhancementPath,
  type EnhancementEngineArtifact,
  type EnhancementEngineKind,
  type EnhancementEngineManifest,
} from '../../shared/enhancement_manifest';

const execute = promisify(execFile);

export async function enhancementFileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyEnhancementEngine(
  directory: string,
  artifact: EnhancementEngineArtifact,
) {
  for (const file of artifact.files) {
    const path = join(directory, file.path);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.size !== file.size ||
      (await enhancementFileHash(path)) !== file.sha256
    )
      throw new Error(`增强引擎文件校验失败：${file.path}`);
  }
}

// 固定的 ONNX 官方 Identity 测试图（v1.17.0，Apache-2.0），真实执行 CPU 会话而非只检查导出名。
const IDENTITY_MODEL =
  'CAoSDGJhY2tlbmQtdGVzdDpbChAKAXgSAXkiCElkZW50aXR5Eg10ZXN0X2lkZW50aXR5WhsKAXgSFgoUCAESEAoCCAEKAggBCgIIAgoCCAJiGwoBeRIWChQIARIQCgIIAQoCCAEKAggCCgIIAkIECgAQFQ==';

/** 原生库只在独立 Node/Electron 子进程中加载；崩溃、超时也不能发布就绪标记。 */
export async function probeEnhancementEngine(
  directory: string,
  kind: EnhancementEngineKind,
): Promise<void> {
  await execute(
    process.execPath,
    [
      '-e',
      `
    const {createRequire} = require('node:module');
    const {join} = require('node:path');
    const from = createRequire(join(process.argv[1], 'package.json'));
    (async () => {
      if (process.argv[2] === 'onnx') {
        const ort = from('onnxruntime-node');
        const session = await ort.InferenceSession.create(Buffer.from('${IDENTITY_MODEL}', 'base64'), {executionProviders:['cpu'], intraOpNumThreads:1});
        try {
          const output = await session.run({x: new ort.Tensor('float32', Float32Array.from([1,2,3,4]), [1,1,2,2])});
          if (Array.from(output.y.data).join(',') !== '1,2,3,4') throw new Error('ONNX CPU 校验结果不匹配');
        } finally { await session.release(); }
        if (typeof from('@receptron/laya').Laya !== 'function' || typeof from('@huggingface/tokenizers').Tokenizer !== 'function') throw new Error('意图引擎加载失败');
      } else if (typeof from('sherpa-onnx-node').OfflineRecognizer !== 'function') throw new Error('语音引擎加载失败');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
      directory,
      kind,
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 60_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
}

export interface EngineTransferState {
  received: number;
  total: number;
  paused: boolean;
  reasons: string[];
}

interface EngineReceipt {
  artifact: EnhancementEngineArtifact;
  verifiedAt: number;
}

/** 引擎按兼容配方与内容身份落盘；新版本完整校验、加载成功前不覆盖旧引擎。 */
export class EnhancementEngineStore {
  readonly root: string;
  readonly target: string;
  private readonly pending = new Map<EnhancementEngineKind, Promise<string>>();
  private readonly transfers = new Map<EnhancementEngineKind, ManagedDownload>();
  private readonly checked = new Set<string>();
  private readonly locations = new Map<
    EnhancementEngineKind,
    { directory: string; receipt: EngineReceipt }
  >();

  constructor(
    appDataRoot: string,
    readonly manifest: EnhancementEngineManifest | null,
    private readonly options: {
      target?: string;
      probe?: typeof probeEnhancementEngine;
      fetcher?: typeof fetch;
      developmentDirectory?: string;
    } = {},
  ) {
    this.root = join(appDataRoot, 'enhancements', 'engines');
    this.target = options.target ?? `${process.platform}-${process.arch}`;
    if (manifest && manifest.target !== this.target)
      throw new Error('增强引擎清单平台与当前宿主不匹配');
  }

  supported(kind: EnhancementEngineKind) {
    return (ENHANCEMENT_ENGINE_RECIPES[kind].targets as readonly string[]).includes(this.target);
  }

  artifact(kind: EnhancementEngineKind) {
    return this.manifest?.engines.find((artifact) => artifact.kind === kind);
  }

  private discover(kind: EnhancementEngineKind) {
    const cached = this.locations.get(kind);
    if (cached && existsSync(cached.directory)) return cached;
    const expected = this.artifact(kind);
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return undefined;
    }
    if (expected) names = [expected.id, ...names.filter((name) => name !== expected.id)];
    for (const name of names) {
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) continue;
      const directory = join(this.root, name);
      try {
        const receipt = JSON.parse(
          readFileSync(join(directory, 'ready.json'), 'utf8'),
        ) as EngineReceipt;
        const validated = parseEnhancementEngineManifest({
          schemaVersion: 1,
          target: this.target,
          engines: [receipt.artifact],
        });
        const artifact = validated.engines[0]!;
        if (artifact.kind !== kind || artifact.id !== name || !Number.isFinite(receipt.verifiedAt))
          continue;
        if (artifact.files.some((file) => !existsSync(join(directory, file.path)))) continue;
        const result = { directory, receipt };
        this.locations.set(kind, result);
        return result;
      } catch {
        /* 未完成、损坏或不兼容的旧目录不参与运行。 */
      }
    }
    return undefined;
  }

  directory(kind: EnhancementEngineKind): string | null {
    return this.discover(kind)?.directory ?? this.developmentDirectory(kind);
  }

  private storedReceipts(kind: EnhancementEngineKind) {
    const receipts: Array<{ directory: string; receipt: EngineReceipt }> = [];
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return receipts;
    }
    for (const name of names) {
      if (!safeEnhancementPath(name) || !name.startsWith(`${kind}-`)) continue;
      const directory = join(this.root, name);
      try {
        const receipt = JSON.parse(
          readFileSync(join(directory, 'ready.json'), 'utf8'),
        ) as EngineReceipt;
        const artifact = receipt.artifact;
        if (artifact.kind !== kind || artifact.id !== name || artifact.target !== this.target)
          continue;
        // 清理旧配方只检查资源归属与文件结构，不把它重新接入当前运行时。
        parseEnhancementEngineManifest({
          schemaVersion: 1,
          target: this.target,
          engines: [{ ...artifact, compatibility: enhancementEngineCompatibility(kind) }],
        });
        receipts.push({ directory, receipt });
      } catch {
        /* 未知目录和未发布的临时目录不按名称删除。 */
      }
    }
    return receipts;
  }

  private storedBytes(kind: EnhancementEngineKind): number {
    const seen = new Set<string>();
    let bytes = 0;
    for (const { directory, receipt } of this.storedReceipts(kind))
      for (const file of receipt.artifact.files) {
        try {
          const info = statSync(join(directory, file.path));
          const key = `${info.dev}:${info.ino}`;
          if (info.isFile() && !seen.has(key)) {
            seen.add(key);
            bytes += info.size;
          }
        } catch {
          /* 损坏文件仍由显式检查与重试处理。 */
        }
      }
    return bytes;
  }

  private developmentDirectory(kind: EnhancementEngineKind): string | null {
    const directory = this.options.developmentDirectory;
    if (!directory || !this.supported(kind)) return null;
    try {
      for (const [name, version] of Object.entries(ENHANCEMENT_ENGINE_RECIPES[kind].packages))
        if (
          JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8'))
            .version !== version
        )
          return null;
      return directory;
    } catch {
      return null;
    }
  }

  state(kind: EnhancementEngineKind) {
    const current = this.discover(kind);
    const artifact = this.artifact(kind);
    const development = !current && this.developmentDirectory(kind);
    return {
      supported: this.supported(kind),
      ready: !!current || !!development,
      updateAvailable: !!current && !!artifact && current.receipt.artifact.id !== artifact.id,
      downloadBytes:
        artifact && !development && artifact.id !== current?.receipt.artifact.id
          ? artifact.downloadBytes
          : 0,
      installedBytes: this.storedBytes(kind) || (development ? (artifact?.installedBytes ?? 0) : 0),
      identity: current
        ? current.receipt.artifact.id +
          ':' +
          current.receipt.artifact.files
            .map((file) => {
              try {
                const info = statSync(join(current.directory, file.path));
                return `${info.size}:${info.mtimeMs}`;
              } catch {
                return 'missing';
              }
            })
            .join('|')
        : development
          ? `development-${enhancementEngineCompatibility(kind)}`
          : '',
      available: !!artifact || !!current || !!development,
      managed: !!current,
    };
  }

  pause(kind: EnhancementEngineKind) {
    this.transfers.get(kind)?.pause();
  }
  resume(kind: EnhancementEngineKind) {
    this.transfers.get(kind)?.continue();
  }

  async checkExisting(kind: EnhancementEngineKind): Promise<void> {
    const current = this.discover(kind);
    const directory = current?.directory ?? this.developmentDirectory(kind);
    if (!directory) throw new Error('增强引擎尚未下载');
    if (current) await verifyEnhancementEngine(directory, current.receipt.artifact);
    await (this.options.probe ?? probeEnhancementEngine)(directory, kind);
    this.checked.add(current?.receipt.artifact.id ?? directory + kind);
  }

  ensure(
    kind: EnhancementEngineKind,
    onProgress?: (state: EngineTransferState) => void,
  ): Promise<string> {
    const existing = this.pending.get(kind);
    if (existing) return existing;
    const task = this.prepare(kind, onProgress).finally(() => this.pending.delete(kind));
    this.pending.set(kind, task);
    return task;
  }

  private async prepare(
    kind: EnhancementEngineKind,
    onProgress?: (state: EngineTransferState) => void,
  ): Promise<string> {
    if (!this.supported(kind)) throw new Error('当前平台没有此增强引擎的兼容预编译版本');
    const current = this.discover(kind);
    const development = !current && this.developmentDirectory(kind);
    if (development) {
      if (!this.checked.has(development + kind)) {
        await (this.options.probe ?? probeEnhancementEngine)(development, kind);
        this.checked.add(development + kind);
      }
      return development;
    }
    const artifact = this.artifact(kind) ?? current?.receipt.artifact;
    if (!artifact) throw new Error('缺少增强引擎分发清单，请重新构建或更新应用');
    const destination = join(this.root, artifact.id);
    if (current?.receipt.artifact.id === artifact.id) {
      let valid = true;
      try {
        await verifyEnhancementEngine(destination, artifact);
        if (!this.checked.has(artifact.id)) {
          await (this.options.probe ?? probeEnhancementEngine)(destination, kind);
          this.checked.add(artifact.id);
        }
      } catch {
        valid = false;
        this.checked.delete(artifact.id);
        this.locations.delete(kind);
        await rm(join(destination, 'ready.json'), { force: true });
      }
      if (valid) return destination;
    }
    await mkdir(this.root, { recursive: true });
    const space = await statfs(this.root);
    if (
      Number(space.bavail) * Number(space.bsize) <
      artifact.downloadBytes + artifact.installedBytes + 32 * 1024 * 1024
    )
      throw new Error('磁盘空间不足，无法准备增强引擎');
    const archive = join(this.root, `${artifact.id}.tar.gz`);
    const staging = join(this.root, `${artifact.id}.${randomUUID()}.staging`);
    const transfer = new ManagedDownload({
      batch: true,
      total: artifact.downloadBytes,
      maxBytes: artifact.downloadBytes,
      fetcher: this.options.fetcher,
      state: onProgress,
      validate: async (path, _response, bytes) => {
        if (
          bytes !== artifact.downloadBytes ||
          (await enhancementFileHash(path)) !== artifact.sha256
        ) {
          await rm(path, { force: true });
          throw new Error('增强引擎下载长度或哈希校验失败，请重试');
        }
      },
    });
    this.transfers.set(kind, transfer);
    try {
      if (
        !existsSync(archive) ||
        (await stat(archive)).size !== artifact.downloadBytes ||
        (await enhancementFileHash(archive)) !== artifact.sha256
      )
        await transfer.file(artifact.url, archive);
      await mkdir(staging);
      const allowed = new Map(
        artifact.files.filter((file) => !file.link).map((file) => [file.path, file]),
      );
      const extracted = new Set<string>();
      let archiveError: Error | undefined;
      await extract({
        file: archive,
        cwd: staging,
        strict: true,
        preservePaths: false,
        filter: (path, entry) => {
          const expected = allowed.get(path);
          if (
            !safeEnhancementPath(path) ||
            !('type' in entry) ||
            entry.type !== 'File' ||
            !expected ||
            entry.size !== expected.size ||
            extracted.has(path)
          ) {
            archiveError = new Error(`增强引擎归档条目无效：${path}`);
            return false;
          }
          extracted.add(path);
          return true;
        },
      });
      if (archiveError) throw archiveError;
      if (extracted.size !== allowed.size) throw new Error('增强引擎归档缺少文件');
      for (const file of artifact.files)
        if (file.link) {
          await mkdir(dirname(join(staging, file.path)), { recursive: true });
          await link(join(staging, file.link), join(staging, file.path));
        }
      await verifyEnhancementEngine(staging, artifact);
      await (this.options.probe ?? probeEnhancementEngine)(staging, kind);
      const receipt: EngineReceipt = { artifact, verifiedAt: Date.now() };
      await writeFile(join(staging, 'ready.json'), JSON.stringify(receipt));
      // 同一进程内按 kind 去重；崩溃遗留但没有 ready 标记的目标可以清理后重试。
      if (existsSync(destination)) {
        if (existsSync(join(destination, 'ready.json')))
          throw new Error('增强引擎目标已存在，请刷新后重试');
        await rm(destination, { recursive: true, force: true });
      }
      await rename(staging, destination);
      this.locations.set(kind, { directory: destination, receipt });
      this.checked.add(artifact.id);
      await rm(archive, { force: true });
      return destination;
    } finally {
      this.transfers.delete(kind);
      await rm(staging, { recursive: true, force: true });
    }
  }

  async remove(kind: EnhancementEngineKind): Promise<void> {
    if (this.pending.has(kind) || enhancementEngineBusy(kind))
      throw new Error('增强引擎正在使用，请稍后删除');
    const ids = new Set(this.storedReceipts(kind).map(({ receipt }) => receipt.artifact.id));
    const expected = this.artifact(kind);
    if (expected) ids.add(expected.id);
    for (const id of ids)
      for (const suffix of ['', '.tar.gz', '.tar.gz.part', '.tar.gz.resume.json'])
        await rm(join(this.root, `${id}${suffix}`), { recursive: true, force: true });
    this.locations.delete(kind);
  }
}

export function readEnhancementEngineManifest(path: string): EnhancementEngineManifest | null {
  if (!existsSync(path)) return null;
  return parseEnhancementEngineManifest(JSON.parse(readFileSync(path, 'utf8')));
}
