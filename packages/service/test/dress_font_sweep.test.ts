/**
 * 字体缓存**全量体检**（{@link DressSharedCache.refreshAllFonts}）的单测。
 *
 * 这条链要解决的是一个真实踩过的坑：native 侧（nt_helper）修了 `hdmx` / `LTSH` 两张表
 * 导致转换产物被浏览器 OTS 拒绝，但宿主的版本号没跟着 +1 —— 于是 sidecar 一直等于「当前
 * 版本」，坏字体在缓存里永生，直到用户手动清缓存。现在两件事钉在这里：
 *
 *  1. 判据是**版本号**（宿主链 + native 链），不是「产物有没有坏」：`fontPipeline`
 *     对不上、或者老 sidecar 压根没这枚字段，就算 stale，要就地重解；
 *  2. 每个「WeQ 版本 × 转换链版本」组合只体检一次（`fonts/.sweep.json`），发版后才
 *     会再来一遍 —— 所以体检不是每次开账号都全量转换。
 *
 * 拿不到原始件（没缓存 zip、没离线 bundle、没在线实例）的那款必须**原样跳过**：旧产物
 * 还能渲染，不能因为一次体检让它变成「装不上」。这里用 `resolvePid: () => 0`（没有在线
 * 实例）+ `queryDressResourceUrl: () => null`（没有离线 bundle）来固定这个前提。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NtHelperBinding } from '@weq/native';
import type { TrpcNative } from '@weq/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DRESS_DERIVE_VERSION,
  DressSharedCache,
  type FontSidecar,
} from '../src/account/dress_shared_cache';
import { setHost, type HostBridge } from '../src/common/host';

// ---- 手工拼最小 zip / sfnt（体检只需要 extractFirstTtf 命中 + isRenderableSfnt 认可） ----

function be16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
}
function be32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v, 0);
  return b;
}
function le16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}
function le32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}

/** 最小合法 zip（store，单条目）。 */
function buildZip(name: string, data: Buffer): Buffer {
  const fileName = Buffer.from(name, 'utf-8');
  const local = Buffer.concat([
    le32(0x04034b50),
    le16(20),
    le16(0),
    le16(0), // method: store
    le16(0),
    le16(0),
    le32(0), // crc（读侧不校验）
    le32(data.length),
    le32(data.length),
    le16(fileName.length),
    le16(0),
    fileName,
    data,
  ]);
  const central = Buffer.concat([
    le32(0x02014b50),
    le16(20),
    le16(20),
    le16(0),
    le16(0), // method: store
    le16(0),
    le16(0),
    le32(0),
    le32(data.length),
    le32(data.length),
    le16(fileName.length),
    le16(0),
    le16(0),
    le16(0),
    le16(0),
    le32(0),
    le32(0), // local 头偏移
    fileName,
  ]);
  const eocd = Buffer.concat([
    le32(0x06054b50),
    le16(0),
    le16(0),
    le16(1),
    le16(1),
    le32(central.length),
    le32(local.length),
    le16(0),
  ]);
  return Buffer.concat([local, central, eocd]);
}

/** 最小 sfnt：`isRenderableSfnt` 认可的 TrueType（head.glyphDataFormat = 0）。 */
function buildSfnt(): Buffer {
  const head = Buffer.alloc(54);
  const dir = Buffer.concat([
    Buffer.from('head'),
    Buffer.alloc(4),
    be32(44), // head 紧跟目录（12 + 2*16）
    be32(54),
    Buffer.from('t1xx'),
    Buffer.alloc(12),
  ]);
  return Buffer.concat([be32(0x00010000), be16(2), Buffer.alloc(6), dir, head]);
}

// ---- 夹具 ----

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface FakeBinding {
  binding: NtHelperBinding;
  /** 每次 `convertFont` 收到的输入路径（用来断言「有没有真的重做」）。 */
  convertCalls: string[];
}

/**
 * 假 binding：`convertFont` 直接落一份合法 sfnt（真 native 会把 FTF 转成标准 TTF，
 * 体检只关心「有没有重做」，不关心转换细节）。
 *
 * `pipeline` 传 `undefined` 模拟**老 native 构建**：没有 `getFontPipelineVersion`
 * 这个导出（锚定的 tag 还没跟上时的形态）。
 */
function makeBinding(pipeline: number | undefined): FakeBinding {
  const convertCalls: string[] = [];
  const binding = {
    convertFont: (inputPath: string, outputPath: string) => {
      convertCalls.push(inputPath);
      writeFileSync(outputPath, buildSfnt());
      return 'success: converted FTF to TTF';
    },
    ...(pipeline === undefined ? {} : { getFontPipelineVersion: () => pipeline }),
    // 没有离线 bundle：重解只能靠已缓存的原始 zip，否则该款应被跳过。
    queryDressResourceUrl: () => null,
  } as unknown as NtHelperBinding;
  return { binding, convertCalls };
}

function makeCache(binding: NtHelperBinding): { cache: DressSharedCache; fontsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'weq-font-sweep-'));
  dirs.push(dir);
  // `resolvePid: () => 0` = 没有在线 QQ 实例（体检必须能纯离线跑完）。
  const cache = new DressSharedCache({} as unknown as TrpcNative, binding, dir, () => 0);
  return { cache, fontsDir: join(dir, 'fonts') };
}

/** 造一份缓存产物：`<id>.ttf` + 可选 sidecar。 */
function writeFont(fontsDir: string, itemId: number, sidecar: FontSidecar | null): void {
  writeFileSync(join(fontsDir, `${itemId}.ttf`), buildSfnt());
  if (sidecar) {
    writeFileSync(join(fontsDir, `${itemId}.json`), JSON.stringify(sidecar, null, 2));
  }
}

/** 造一份**已缓存的原始 zip**（内含 ttf）—— 离线重解就靠它。 */
function writeCachedZip(fontsDir: string, itemId: number): void {
  writeFileSync(join(fontsDir, `${itemId}.zip`), buildZip(`${itemId}.ttf`, buildSfnt()));
}

function readSidecar(fontsDir: string, itemId: number): FontSidecar {
  return JSON.parse(readFileSync(join(fontsDir, `${itemId}.json`), 'utf-8')) as FontSidecar;
}

describe('DressSharedCache.refreshAllFonts', () => {
  it('版本都对得上：一款都不重做，也不碰 zip', async () => {
    const { binding, convertCalls } = makeBinding(2);
    const { cache, fontsDir } = makeCache(binding);
    writeFont(fontsDir, 10001, { deriveVersion: DRESS_DERIVE_VERSION, fontPipeline: 2 });
    writeCachedZip(fontsDir, 10001);

    expect(await cache.refreshAllFonts()).toBe(0);
    expect(convertCalls).toEqual([]);
    expect(cache.isFontDerived(10001)).toBe(true);
  });

  it('native 字体链版本落后：就地重解，并把新版本写回 sidecar', async () => {
    const { binding, convertCalls } = makeBinding(2);
    const { cache, fontsDir } = makeCache(binding);
    writeFont(fontsDir, 10002, { deriveVersion: DRESS_DERIVE_VERSION, fontPipeline: 0 });
    writeCachedZip(fontsDir, 10002);

    expect(await cache.refreshAllFonts()).toBe(1);
    expect(convertCalls).toHaveLength(1);
    expect(readSidecar(fontsDir, 10002)).toMatchObject({
      deriveVersion: DRESS_DERIVE_VERSION,
      fontPipeline: 2,
    });
    expect(cache.isFontDerived(10002)).toBe(true);
  });

  it('老 sidecar（旧派生版本、没有 fontPipeline 字段）：算 stale，同样就地重解', async () => {
    const { binding, convertCalls } = makeBinding(2);
    const { cache, fontsDir } = makeCache(binding);
    // 4 号产物就是这个坑的当事人：native 修了 hdmx/LTSH，宿主没 +1。
    writeFont(fontsDir, 10003, { deriveVersion: 4 });
    writeCachedZip(fontsDir, 10003);

    expect(await cache.refreshAllFonts()).toBe(1);
    expect(convertCalls).toHaveLength(1);
    expect(cache.isFontDerived(10003)).toBe(true);
  });

  it('老 native 构建（没有 getFontPipelineVersion 导出）：两边都是未知的 0，不算 stale', async () => {
    const { binding, convertCalls } = makeBinding(undefined);
    const { cache, fontsDir } = makeCache(binding);
    // 这个组合下只有 DRESS_DERIVE_VERSION 在管 —— 与加 fontPipeline 之前的行为一致。
    writeFont(fontsDir, 10007, { deriveVersion: DRESS_DERIVE_VERSION, fontPipeline: 0 });
    writeCachedZip(fontsDir, 10007);

    expect(await cache.refreshAllFonts()).toBe(0);
    expect(convertCalls).toEqual([]);
  });

  it('老 native 构建下，老派生版本的产物照样重解', async () => {
    const { binding, convertCalls } = makeBinding(undefined);
    const { cache, fontsDir } = makeCache(binding);
    writeFont(fontsDir, 10008, { deriveVersion: 3 });
    writeCachedZip(fontsDir, 10008);

    expect(await cache.refreshAllFonts()).toBe(1);
    expect(convertCalls).toHaveLength(1);
    expect(cache.isFontDerived(10008)).toBe(true);
  });

  it('拿不到原始件（没 zip / 没离线 bundle / 没在线实例）：原样跳过，绝不动旧产物', async () => {
    const { binding, convertCalls } = makeBinding(2);
    const { cache, fontsDir } = makeCache(binding);
    const before = buildSfnt();
    writeFileSync(join(fontsDir, '10004.ttf'), before);
    writeFileSync(
      join(fontsDir, '10004.json'),
      JSON.stringify({ itemId: 10004, deriveVersion: 4 } satisfies FontSidecar),
    );

    expect(await cache.refreshAllFonts()).toBe(0);
    expect(convertCalls).toEqual([]);
    expect(existsSync(join(fontsDir, '10004.ttf'))).toBe(true);
    expect(readFileSync(join(fontsDir, '10004.ttf'))).toEqual(before);
    expect(readSidecar(fontsDir, 10004).deriveVersion).toBe(4);
  });

  it('没有 sidecar、只有 ttf 的孤儿产物：也纳入体检并补上 sidecar', async () => {
    const { binding } = makeBinding(2);
    const { cache, fontsDir } = makeCache(binding);
    writeFont(fontsDir, 10009, null);
    writeCachedZip(fontsDir, 10009);

    expect(await cache.refreshAllFonts()).toBe(1);
    expect(readSidecar(fontsDir, 10009)).toMatchObject({ fontPipeline: 2 });
  });

  it('换个 WeQ 版本不会再体检，发版后才重新跑一遍', async () => {
    let appVersion = '2.0.3';
    setHost({ appVersion: () => appVersion } as unknown as HostBridge);
    const { binding, convertCalls } = makeBinding(2);
    const { cache, fontsDir } = makeCache(binding);

    writeFont(fontsDir, 10005, { deriveVersion: 4 });
    writeCachedZip(fontsDir, 10005);
    expect(await cache.refreshAllFonts()).toBe(1);
    expect(convertCalls).toHaveLength(1);

    // 同一版本里又冒出一款落后产物：戳没变，这一轮不扫（否则每次开账号都全量转换）。
    writeFont(fontsDir, 10006, { deriveVersion: 4 });
    writeCachedZip(fontsDir, 10006);
    expect(await cache.refreshAllFonts()).toBe(0);
    expect(convertCalls).toHaveLength(1);

    // 发版 → 戳失效，整个目录重扫一遍，把 10006 补上。
    appVersion = '2.0.4';
    expect(await cache.refreshAllFonts()).toBe(1);
    expect(convertCalls).toHaveLength(2);
    expect(cache.isFontDerived(10006)).toBe(true);
  });
});
