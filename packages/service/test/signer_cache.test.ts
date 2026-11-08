/**
 * `signer_cache` —— 签名器 RVA 的缓存与预热。
 *
 * 锁四件事：
 *   1. 缓存命中时**不重扫**：只调 `warmupSigner`，读回实际 RVA；
 *   2. 文件变了（size / mtimeNs 不同）就当缓存失效，重扫并写回；
 *   3. 失效的 RVA（native 校验不过）也会重扫；
 *   4. 预热结果写进进程内提示，`setSsoSession` 那条路能直接拿到。
 *
 * 数据全部是临时目录里的假文件 + stub native，不碰真 QQ 安装。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignCheckReport } from '@weq/native';
import {
  describeSignerCache,
  getSignerHints,
  matchSignerCacheEntry,
  readSignerCache,
  rememberSignerHints,
  storeSignerCacheEntry,
  warmupSigner,
} from '../src/bootstrap/signer_cache';

const SIGN_CORE_RVA = 0x6850_0c4;
const VM_RVA = 0x6e4f_fcc;

let root: string;
let wrapper: string;

function report(overrides: Partial<SignCheckReport> = {}): SignCheckReport {
  return {
    describe: 'ELF64 (little-endian, x86-64)',
    signCoreRva: SIGN_CORE_RVA,
    signCoreMs: 400,
    vmRva: VM_RVA,
    vmKind: 'linux-vm-entry',
    vmMs: 0,
    pathUsed: 'vm',
    signLengths: [48],
    sampleSign: 'AA',
    failures: 0,
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-signer-'));
  wrapper = join(root, 'wrapper.node');
  writeFileSync(wrapper, Buffer.alloc(1024, 7));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('matchSignerCacheEntry', () => {
  it('文件指纹一致时命中，文件改动后判失效', () => {
    rememberSignerHints(wrapper, SIGN_CORE_RVA, VM_RVA);
    const entry = {
      version: '3.2.35-54395',
      wrapperPath: wrapper,
      sha256: 'AB'.repeat(32),
      stamp: { size: 1024, mtimeNs: '1' },
      signCoreRva: SIGN_CORE_RVA,
      vmRva: VM_RVA,
      vmKind: 'linux-vm-entry',
      verifiedAt: 1,
      pathUsed: 'vm',
    };
    // stamp 对不上 → hash-changed（不是 missing：路径本身就是这个文件）。
    expect(matchSignerCacheEntry(entry, wrapper)).toBe('hash-changed');
    expect(matchSignerCacheEntry(undefined, wrapper)).toBe('missing');
    expect(matchSignerCacheEntry(entry, join(root, 'other.node'))).toBe('missing');
  });
});

describe('warmupSigner', () => {
  it('首次扫描会把结果写进缓存，并留下进程内提示', async () => {
    const checkSigner = vi.fn(() => report());
    const warmup = vi.fn(async () => true);
    const signerRvas = vi.fn(() => ({ signCoreRva: SIGN_CORE_RVA, vmRva: VM_RVA }));
    const nt = { checkSigner, warmupSigner: warmup, signerRvas };

    const result = await warmupSigner(nt, root, wrapper, '3.2.35-54395');

    expect(result.outcome).toBe('scanned');
    expect(result.signCoreRva).toBe(SIGN_CORE_RVA);
    expect(result.vmRva).toBe(VM_RVA);
    expect(result.sha256).toHaveLength(64);
    expect(checkSigner).toHaveBeenCalledTimes(1);
    // 首次没有缓存，不该走 warmup 那条短路径。
    expect(warmup).not.toHaveBeenCalled();

    const stored = readSignerCache(root).entries[wrapper];
    expect(stored).toMatchObject({
      version: '3.2.35-54395',
      signCoreRva: SIGN_CORE_RVA,
      vmRva: VM_RVA,
      pathUsed: 'vm',
    });
    expect(getSignerHints(wrapper)).toEqual({ signCoreRva: SIGN_CORE_RVA, vmRva: VM_RVA });
  });

  it('缓存命中时只加载不重扫', async () => {
    const checkSigner = vi.fn(() => report());
    await warmupSigner({ checkSigner }, root, wrapper, null);

    const warmup = vi.fn(async () => true);
    const signerRvas = vi.fn(() => ({ signCoreRva: SIGN_CORE_RVA, vmRva: VM_RVA }));
    const result = await warmupSigner(
      { checkSigner, warmupSigner: warmup, signerRvas },
      root,
      wrapper,
      null,
    );

    expect(result.outcome).toBe('cache-hit');
    expect(warmup).toHaveBeenCalledWith(wrapper, SIGN_CORE_RVA, VM_RVA);
    // 关键断言：命中缓存时**没有**再跑完整扫描。
    expect(checkSigner).toHaveBeenCalledTimes(1); // 只有第一次那回
  });

  it('native 拒绝缓存的 RVA 时退回完整扫描', async () => {
    const checkSigner = vi.fn(() => report());
    await warmupSigner({ checkSigner }, root, wrapper, null);

    const result = await warmupSigner(
      {
        checkSigner,
        warmupSigner: vi.fn(async () => false),
        signerRvas: vi.fn(() => null),
      },
      root,
      wrapper,
      null,
    );

    expect(result.outcome).toBe('scanned');
    expect(checkSigner).toHaveBeenCalledTimes(2);
  });

  it('wrapper 不存在时不动缓存，直接报失败', async () => {
    const checkSigner = vi.fn(() => report());
    const result = await warmupSigner({ checkSigner }, root, join(root, 'missing.node'), null);
    expect(result.outcome).toBe('failed');
    expect(checkSigner).not.toHaveBeenCalled();
  });

  it('没有 wrapper 路径时按跳过处理（例如 QQ 没装）', async () => {
    const result = await warmupSigner({}, root, null, null);
    expect(result.outcome).toBe('skipped');
    expect(result.wrapperPath).toBeNull();
  });

  it('老 native 没有 checkSigner 时报明确的失败原因', async () => {
    const result = await warmupSigner({}, root, wrapper, null);
    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('不支持签名器扫描');
  });
});

describe('describeSignerCache', () => {
  it('没扫过 = missing，扫过且文件没变 = hit', async () => {
    expect(describeSignerCache(root, wrapper, '3.2.35-54395').state).toBe('missing');

    await warmupSigner({ checkSigner: () => report() }, root, wrapper, '3.2.35-54395');
    const status = describeSignerCache(root, wrapper, '3.2.35-54395');
    expect(status.state).toBe('hit');
    expect(status.signCoreRva).toBe(SIGN_CORE_RVA);
    expect(status.pathUsed).toBe('vm');
  });

  it('文件被替换（mtime 变了）= stale', async () => {
    await warmupSigner({ checkSigner: () => report() }, root, wrapper, null);
    writeFileSync(wrapper, Buffer.alloc(2048, 9));
    expect(describeSignerCache(root, wrapper, null).state).toBe('stale');
  });

  it('缓存里记录的路径不会顶替当前安装的版本', async () => {
    storeSignerCacheEntry(root, {
      version: 'old',
      wrapperPath: wrapper,
      sha256: 'CD'.repeat(32),
      stamp: { size: 1, mtimeNs: '1' },
      signCoreRva: 1,
      vmRva: null,
      vmKind: null,
      verifiedAt: 1,
      pathUsed: null,
    });
    // 同步安装版本优先。
    expect(describeSignerCache(root, wrapper, '3.2.35-54395').version).toBe('3.2.35-54395');
  });
});
