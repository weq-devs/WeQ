/**
 * 签名器缓存：记住每个 `wrapper.node` 的「版本 + 文件指纹 + 两个 RVA」。
 *
 * 为什么要缓存：`wrapper.node` 有 140–200 MB，从零定位 sign core / VM 实测
 * 约 2.5–3 秒（冷启动 `checkSigner` 最长见过 3.6 秒）。这个代价不该落在第一包
 * 需要签名的请求上，更不该每包都付一次。缓存命中时 native 侧只做 dlopen +
 * 可执行段校验（约 0.5 秒），静态扫描整段跳过。
 *
 * 失效条件：QQ 每次更新都会换 `wrapper.node`（新路径、新大小、新 mtime），
 * 所以缓存键里带 **sha256**；路径变了自然 miss，同路径被原地替换时靠 hash 兜底。
 * `size + mtimeNs` 只是用来在重算 hash 之前先判断「文件根本没动」——算一次
 * 140 MB 的 sha256 约 0.2 秒，不能每次启动都做。
 *
 * 缓存落盘在 `<appData>/signer-cache.json`，跟 `config.json` 同级。**只存公开
 * 信息**（版本、hash、RVA、时间戳），不碰任何凭据。
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { NtHelperBinding } from '@weq/native';
import { getLogger } from '../common/logger';
import { readJsonFile, writeJsonFileAtomic } from '../common/json_store';

const logger = getLogger().child({ scope: 'signer-cache' });

/** 缓存的失效策略：文件指纹（size + mtimeNs）变了就重算 hash。 */
interface FileStamp {
  size: number;
  mtimeNs: string;
}

/** 一个 `wrapper.node` 的缓存条目。 */
export interface SignerCacheEntry {
  /** QQ 版本，例如 `3.2.35-54395`；拿不到时为 null。 */
  version: string | null;
  /** `wrapper.node` 的绝对路径。 */
  wrapperPath: string;
  /** 文件的 sha256（大写十六进制），仅在指纹变化时重算。 */
  sha256: string;
  /** 上面 hash 对应的文件指纹。 */
  stamp: FileStamp;
  /** sign core 的 RVA。 */
  signCoreRva: number;
  /** VM 入口的 RVA；没有可用 VM 时为 null。 */
  vmRva: number | null;
  /** VM 形态，例如 `linux-vm-entry`。 */
  vmKind: string | null;
  /** 最近一次确认可用的时间（Unix ms）。 */
  verifiedAt: number;
  /** 最近一次实际签名的路径：`vm` / `sign-core`。 */
  pathUsed: string | null;
}

export interface SignerCacheFile {
  /** 按 wrapper.node 绝对路径索引。 */
  entries: Record<string, SignerCacheEntry>;
}

const CACHE_FILE = 'signer-cache.json';
const READ_CHUNK = 4 * 1024 * 1024;

function fileStamp(path: string): FileStamp | null {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile()) return null;
    return { size: Number(stat.size), mtimeNs: stat.mtimeNs.toString() };
  } catch {
    return null;
  }
}

/** 分块算 sha256；140 MB 实测约 0.2 秒，不会长时间占住事件循环以外的东西。 */
function sha256File(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex').toUpperCase();
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function cachePath(appDataRoot: string): string {
  return `${appDataRoot}/${CACHE_FILE}`;
}

// ── 进程内热缓存 ────────────────────────────────────────────────────
//
// 发包路径（`sso_session` 的 `setSsoSession`）在 service 层深处，拿不到
// `appDataRoot`，也不该为读一份提示去碰磁盘。预热/扫描成功后写进这里，
// 登记会话时直接取；进程重启后由启动期预热重新填充。

const memoryHints = new Map<string, { signCoreRva: number; vmRva: number | null }>();

/** 记下一次可用的 RVA（预热 / 自检成功后调用）。 */
export function rememberSignerHints(
  wrapperPath: string,
  signCoreRva: number,
  vmRva: number | null,
): void {
  memoryHints.set(wrapperPath, { signCoreRva, vmRva });
}

/** 取某个 `wrapper.node` 的 RVA 提示；没预热过时为 undefined。 */
export function getSignerHints(
  wrapperPath: string | null | undefined,
): { signCoreRva: number; vmRva: number | null } | undefined {
  if (!wrapperPath) return undefined;
  return memoryHints.get(wrapperPath);
}

/** 读整个缓存文件；坏文件按空缓存处理（下次写入会覆盖）。 */
export function readSignerCache(appDataRoot: string): SignerCacheFile {
  const raw = readJsonFile(cachePath(appDataRoot)) as SignerCacheFile | null;
  if (!raw || typeof raw !== 'object' || typeof raw.entries !== 'object' || !raw.entries)
    return { entries: {} };
  return raw;
}

function writeSignerCache(appDataRoot: string, cache: SignerCacheFile): void {
  // 缓存文件：写失败不阻断预热（下轮重扫即可），所以用宽容写。
  writeJsonFileAtomic(cachePath(appDataRoot), cache, true);
}

/**
 * 判定缓存条目是否还适用于当前文件。
 *
 * 返回 `'hit'` = 直接可用；`'hash-changed'` / `'missing'` = 需要重扫。
 * 只比对 `size + mtimeNs`：两者都吻合就不会有人偷偷改了文件而不更新元数据。
 */
export function matchSignerCacheEntry(
  entry: SignerCacheEntry | undefined,
  wrapperPath: string,
): 'hit' | 'hash-changed' | 'missing' {
  if (!entry) return 'missing';
  if (entry.wrapperPath !== wrapperPath) return 'missing';
  const stamp = fileStamp(wrapperPath);
  if (!stamp) return 'missing';
  if (stamp.size !== entry.stamp.size || stamp.mtimeNs !== entry.stamp.mtimeNs)
    return 'hash-changed';
  return 'hit';
}

/** 写入/更新一个条目（读改写整个文件；调用方串行化 —— 预热本来就只有一条路径）。 */
export function storeSignerCacheEntry(
  appDataRoot: string,
  entry: SignerCacheEntry,
): SignerCacheFile {
  const cache = readSignerCache(appDataRoot);
  cache.entries[entry.wrapperPath] = entry;
  writeSignerCache(appDataRoot, cache);
  return cache;
}

/** 计算文件当前指纹 + sha256；供扫描前后确认「扫的就是这个文件」。 */
export function fingerprintWrapper(
  wrapperPath: string,
): { stamp: FileStamp; sha256: string } | null {
  const stamp = fileStamp(wrapperPath);
  if (!stamp) return null;
  const sha256 = sha256File(wrapperPath);
  if (!sha256) return null;
  return { stamp, sha256 };
}

/**
 * 预热结果：给 UI / 日志看的状态快照。
 *
 * `outcome` 说明这次预热实际做了什么：
 *   - `cache-hit`   ？ 走缓存 RVA，native 侧只 dlopen + 校验；
 *   - `scanned`     完整扫描了一遍，并把结果写回缓存；
 *   - `skipped`     没有可用的 `wrapper.node` / 平台不支持；
 *   - `failed`      native 报错（路径存在但加载失败）。
 */
export interface SignerWarmupResult {
  outcome: 'cache-hit' | 'scanned' | 'skipped' | 'failed';
  wrapperPath: string | null;
  version: string | null;
  sha256: string | null;
  signCoreRva: number | null;
  vmRva: number | null;
  vmKind: string | null;
  pathUsed: string | null;
  elapsedMs: number;
  error: string | null;
}

/** 预热可以用到的 native 接口（测试里传 stub）。 */
export type SignerNative = Pick<NtHelperBinding, 'checkSigner' | 'warmupSigner' | 'signerRvas'>;

/**
 * 预热某个 `wrapper.node`：命中缓存就用缓存的 RVA，否则完整扫一遍并写回缓存。
 *
 * **不签名**：只加载 + 校验，所以不会因为服务端/版本问题在这里失败。
 * 真正的「能否签名」由 `checkSigner`（诊断页手动触发）确认。
 */
export async function warmupSigner(
  nt: SignerNative,
  appDataRoot: string,
  wrapperPath: string | null,
  version: string | null,
): Promise<SignerWarmupResult> {
  const base: SignerWarmupResult = {
    outcome: 'skipped',
    wrapperPath,
    version,
    sha256: null,
    signCoreRva: null,
    vmRva: null,
    vmKind: null,
    pathUsed: null,
    elapsedMs: 0,
    error: null,
  };
  if (!wrapperPath) return base;
  const stamp = fileStamp(wrapperPath);
  if (!stamp) {
    return { ...base, outcome: 'failed', error: 'wrapper.node 不存在或不可读' };
  }

  const started = Date.now();
  const cache = readSignerCache(appDataRoot);
  const cached = cache.entries[wrapperPath];
  const match = matchSignerCacheEntry(cached, wrapperPath);

  const warmup = nt.warmupSigner?.bind(nt);
  const readRvas = nt.signerRvas?.bind(nt);

  if (match === 'hit' && cached && warmup) {
    try {
      const ok = await warmup(wrapperPath, cached.signCoreRva, cached.vmRva);
      if (ok) {
        const actual = readRvas?.(wrapperPath) ?? null;
        const result: SignerWarmupResult = {
          outcome: 'cache-hit',
          wrapperPath,
          version,
          sha256: cached.sha256,
          signCoreRva: actual?.signCoreRva ?? cached.signCoreRva,
          vmRva: actual?.vmRva ?? cached.vmRva,
          vmKind: cached.vmKind,
          pathUsed: cached.pathUsed,
          elapsedMs: Date.now() - started,
          error: null,
        };
        rememberSignerHints(
          wrapperPath,
          actual?.signCoreRva ?? cached.signCoreRva,
          actual?.vmRva ?? cached.vmRva ?? null,
        );
        // native 侧校验失败时会静默重扫；只有 RVA 真的变了才需要回写。
        if (
          actual &&
          (actual.signCoreRva !== cached.signCoreRva || actual.vmRva !== cached.vmRva)
        ) {
          storeSignerCacheEntry(appDataRoot, {
            ...cached,
            version,
            signCoreRva: actual.signCoreRva ?? cached.signCoreRva,
            vmRva: actual.vmRva ?? null,
            vmKind: actual.vmRva === null ? null : (cached.vmKind ?? null),
            verifiedAt: Date.now(),
          });
        }
        logger.info('signer warmup used the cached rvas', {
          event: 'signer-warmup',
          ...logFields(result),
        });
        return result;
      }
      logger.warn('cached rvas were rejected; rescanning', {
        event: 'signer-warmup',
        wrapperPath,
      });
    } catch (error) {
      logger.warn('signer warmup with cached rvas failed; rescanning', {
        event: 'signer-warmup',
        wrapperPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 完整扫描：checkSigner 会顺带签名一次，确认 RVA 真的可用。
  const check = nt.checkSigner?.bind(nt);
  if (!check) {
    return {
      ...base,
      outcome: 'failed',
      elapsedMs: Date.now() - started,
      error: '当前 native 构建不支持签名器扫描（请更新 nt_helper）',
    };
  }
  try {
    const report = check(wrapperPath, 1);
    const signCoreRva = report.signCoreRva ?? null;
    if (signCoreRva === null) {
      return {
        ...base,
        outcome: 'failed',
        elapsedMs: Date.now() - started,
        error: report.signCoreError ?? 'sign core 定位失败',
      };
    }
    const fp = fingerprintWrapper(wrapperPath);
    const result: SignerWarmupResult = {
      outcome: 'scanned',
      wrapperPath,
      version,
      sha256: fp?.sha256 ?? null,
      signCoreRva,
      vmRva: report.vmRva ?? null,
      vmKind: report.vmKind ?? null,
      pathUsed: report.pathUsed ?? null,
      elapsedMs: Date.now() - started,
      error: null,
    };
    rememberSignerHints(wrapperPath, signCoreRva, report.vmRva ?? null);
    if (fp) {
      storeSignerCacheEntry(appDataRoot, {
        version,
        wrapperPath,
        sha256: fp.sha256,
        stamp: fp.stamp,
        signCoreRva,
        vmRva: report.vmRva ?? null,
        vmKind: report.vmKind ?? null,
        verifiedAt: Date.now(),
        pathUsed: report.pathUsed ?? null,
      });
    }
    logger.info('signer scanned and cached', { event: 'signer-warmup', ...logFields(result) });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('signer scan failed', { event: 'signer-warmup', wrapperPath, error: message });
    return { ...base, outcome: 'failed', elapsedMs: Date.now() - started, error: message };
  }
}

/**
 * 只读地看当前缓存状态（诊断页用）。做一次文件指纹比对，但**不算 hash**
 * —— 那 0.2 秒不该花在打开设置页上。
 */
export interface SignerCacheStatus {
  wrapperPath: string | null;
  version: string | null;
  sha256: string | null;
  signCoreRva: number | null;
  vmRva: number | null;
  vmKind: string | null;
  pathUsed: string | null;
  verifiedAt: number | null;
  /** `hit` = 缓存对当前文件有效；`stale` = 文件变了；`missing` = 没扫过。 */
  state: 'hit' | 'stale' | 'missing';
}

export function describeSignerCache(
  appDataRoot: string,
  wrapperPath: string | null,
  version: string | null,
): SignerCacheStatus {
  const base: SignerCacheStatus = {
    wrapperPath,
    version,
    sha256: null,
    signCoreRva: null,
    vmRva: null,
    vmKind: null,
    pathUsed: null,
    verifiedAt: null,
    state: 'missing',
  };
  if (!wrapperPath) return base;
  const entry = readSignerCache(appDataRoot).entries[wrapperPath];
  if (!entry) return base;
  const match = matchSignerCacheEntry(entry, wrapperPath);
  return {
    wrapperPath,
    // 版本跟着当前安装走：缓存里的版本只是记录扫描时的值。
    version: version ?? entry.version,
    sha256: entry.sha256,
    signCoreRva: entry.signCoreRva,
    vmRva: entry.vmRva,
    vmKind: entry.vmKind,
    pathUsed: entry.pathUsed,
    verifiedAt: entry.verifiedAt,
    state: match === 'hit' ? 'hit' : match === 'hash-changed' ? 'stale' : 'missing',
  };
}

function logFields(result: SignerWarmupResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    wrapperPath: result.wrapperPath,
    version: result.version,
    signCoreRva: result.signCoreRva,
    vmRva: result.vmRva,
    pathUsed: result.pathUsed,
    elapsedMs: result.elapsedMs,
    error: result.error,
  };
}
