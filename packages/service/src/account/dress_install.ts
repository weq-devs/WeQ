/**
 * 装扮的本地安装与清单管理。
 *
 * 气泡与字体的获取路径完全不同,这是本模块存在的主要原因:
 *
 *  - **气泡**:资源外链**推不出来**(新款目录段是服务端 nonce,详见 {@link ./bubble_skin}
 *    模块头)。所以有两条来源:商城条目自带的 `immersiveMaterial`(排行/搜索/安装走这条,
 *    零凭证零探测),或只有 itemId 时走 protocol 的 scupdate 换取(需在线实例)。
 *  - **字体**:TTF 直链带服务端生成的 hash 段,本地推导不出;老字体(engine=2)连商城
 *    接口都不给直链。唯一可靠路径是走 `scupdate` 换下载链(见 @weq/protocol),那要发
 *    手Q 独有的 SSO 包,**必须有已注入的在线 QQ 进程**。
 *
 * 所以离线时:商城来的气泡照常能装(material 里有权威外链),只有 itemId 的那款
 * (bootstrap 从 getSelfDress 拿到的「QQ 正在用的」)装不了 —— 那条要 protocol。
 *
 * ## 为什么要清单文件
 *
 * 气泡的 slice / 文字色 / **权威外链**都是解析出来的,不落盘的话每次启动都要重来,而
 * 外链还依赖商城响应或在线实例 —— 离线启动就再也拼不出来了。清单同时也是「我的装扮」
 * 列表的数据源,比扫目录可靠 —— 气泡根本没有自己的目录。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { TrpcNative } from '@weq/protocol';
import { getBubbleResources, getFontResource } from '@weq/protocol';
import type { AvatarCacheService } from '../bootstrap/avatar_cache';
import { getLogger, logErrorContext } from '../common/logger';
import { writeFileAtomicSync } from './atomic_write';
import {
  legacyBubbleStaticUrl,
  resolveBubbleSkin,
  type BubbleSkin,
  type BubbleSource,
} from './bubble_skin';
import type { BubbleMaterial } from './web/dress_mall';
import { downloadUrlToFile } from './media_url';

/** 已装的一款字体。 */
export interface InstalledFont {
  itemId: number;
  name: string;
  /** `@font-face` 用的 family 名。 */
  family: string;
  /** ttf 的绝对路径。 */
  file: string;
}

/**
 * 装扮作用范围。`mine` 只渲染自己的消息,`all` 连对方的一起渲染。
 *
 * 默认 `mine`,因为这才是手 Q 的语义 —— 气泡/字体是「我买的装扮」,对方看到的是他自己
 * 的。`all` 纯属本地观感偏好。
 */
export type DressScope = 'mine' | 'all';

/** 本地装扮清单。 */
export interface DressManifest {
  bubbles: BubbleSkin[];
  fonts: InstalledFont[];
  /** 当前生效的气泡 itemId(0 = 不用装扮气泡)。 */
  activeBubble: number;
  /** 当前生效的字体 itemId(0 = 用默认字体)。 */
  activeFont: number;
  scope: DressScope;
}

/**
 * 空清单。**必须是工厂函数而不是共享常量** —— 调用方会往 `bubbles`/`fonts` 里 push,
 * 若返回同一个对象的浅拷贝,数组仍是同一个引用,一次 push 就把「空清单」永久污染了。
 */
function emptyManifest(): DressManifest {
  return { bubbles: [], fonts: [], activeBubble: 0, activeFont: 0, scope: 'mine' };
}

/** `@font-face` 的 family 名 —— 与渲染侧 dressSkin.ts 的约定必须一致。 */
export function fontFamilyFor(itemId: number): string {
  return `weq-dress-${itemId}`;
}

export class DressInstallService {
  private readonly logger;

  constructor(
    private readonly nt: TrpcNative,
    private readonly avatarCache: AvatarCacheService,
    /** 装扮缓存根目录(通常是 `userConfig.cacheDir('dress')`)。 */
    private readonly rootDir: string,
    /** 当前已注入的 QQ pid;0 表示没有在线实例。 */
    private readonly resolvePid: () => number,
  ) {
    this.logger = getLogger().child({ scope: 'dress-install' });
  }

  private get manifestPath(): string {
    return join(this.rootDir, 'manifest.json');
  }

  /** 读清单。文件不存在 / 损坏时回空清单(装扮是锦上添花,不该因此启动失败)。 */
  read(): DressManifest {
    try {
      const raw = JSON.parse(readFileSync(this.manifestPath, 'utf-8')) as Partial<DressManifest>;
      return {
        bubbles: Array.isArray(raw.bubbles) ? raw.bubbles : [],
        fonts: Array.isArray(raw.fonts) ? raw.fonts : [],
        activeBubble: Number(raw.activeBubble ?? 0),
        activeFont: Number(raw.activeFont ?? 0),
        scope: raw.scope === 'all' ? 'all' : 'mine',
      };
    } catch {
      return emptyManifest();
    }
  }

  private write(manifest: DressManifest): void {
    writeFileAtomicSync(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  /**
   * 安装一款气泡:定位权威外链 → 解析几何 → 记清单。已装过则重用记录。
   *
   * @param material 商城条目自带的权威参数。**有它就是快路径**(外链/拉伸点/文字色齐全,
   *                 只下一张整图);没有则回退 {@link resolveBubbleUrl} 去找外链。
   */
  async installBubble(itemId: number, material?: BubbleMaterial | null): Promise<BubbleSkin | null> {
    const manifest = this.read();
    const known = manifest.bubbles.find((b) => b.itemId === itemId);
    if (known) return known;

    const src = material
      ? ({
          staticUrl: material.staticAll,
          animationUrl: material.animationAll,
          zoomPoint: { x: material.zoomPointX, y: material.zoomPointY },
          color: material.color,
        } satisfies BubbleSource)
      : await this.resolveBubbleUrl(itemId);
    if (!src) return null;

    const skin = await resolveBubbleSkin(this.avatarCache, itemId, src);
    if (!skin) return null;

    manifest.bubbles.push(skin);
    this.write(manifest);
    this.logger.info('installed bubble', {
      event: 'dress-install-bubble',
      itemId,
      animated: skin.animated,
      viaMaterial: Boolean(material),
    });
    return skin;
  }

  /**
   * 只有 itemId 时找气泡的权威外链。
   *
   * 顺序有讲究:
   *  1. 先试老式 `immersive/bubble/<itemId>/` —— 老款有效,零成本零凭证,离线也能过。
   *  2. 再走 protocol 的 scupdate 换 `static.zip`。新款的 immersive 目录段是服务端
   *     nonce(推不出来,见 bubble_skin 模块头),这是唯一的兜底,**需要在线实例**。
   *
   * 走到 2 时把整图从 zip 里解出来写进缓存目录,再交给解析层 —— 这样清单里存的
   * `staticUrl` 是个本地 `file://`,离线重启也画得出来。
   */
  private async resolveBubbleUrl(itemId: number): Promise<BubbleSource | null> {
    const legacy = legacyBubbleStaticUrl(itemId);
    if (await urlExists(legacy)) {
      // 老款:动效有无、拉伸点、文字色都交给解析层探(同目录兄弟资源都在)。
      return { staticUrl: legacy };
    }

    const pid = this.resolvePid();
    if (!pid) {
      this.logger.warn('bubble needs online instance', {
        event: 'dress-bubble-needs-online',
        itemId,
      });
      return null;
    }

    const res = await getBubbleResources(this.nt, pid, itemId);
    if (!res.staticZip?.ok) return null;

    const dir = join(this.rootDir, 'bubbles');
    mkdirSync(dir, { recursive: true });
    const zipPath = join(dir, `${itemId}.zip`);
    const dl = await downloadUrlToFile(res.staticZip.url, zipPath);
    if (!dl.ok) return null;

    // 包里的九宫格本体叫 aio_user_bg_nor.9.png（与 immersive 的 static-all.png 逐像素一致）。
    const png = extractFromZip(readFileSync(zipPath), (n) => /aio_user_bg_nor\.9\.png$/i.test(n));
    if (!png) return null;

    // .9.png 的 npTc chunk 里就有权威拉伸点(实测与 material 的 zoomPoint 一致),
    // 拿不到就没法渲染 —— 本地路径没有兄弟切片可量。
    const zoom = readNinePatchZoom(png);
    if (!zoom) {
      this.logger.warn('nine-patch without npTc zoom point', {
        event: 'dress-bubble-no-nptc',
        itemId,
      });
      return null;
    }

    const pngPath = join(dir, `${itemId}.png`);
    writeFileSync(pngPath, png);
    return {
      staticUrl: '',
      localFile: pngPath,
      zoomPoint: zoom,
      // zip 路径拿不到动效层,按「无动效」处理。
      animationUrl: '',
    };
  }

  /**
   * 安装一款字体:换下载链 → 下 zip → 解出 ttf → 记清单。
   *
   * 需要在线实例(见模块头)。已装过且文件还在则直接返回记录。
   */
  async installFont(itemId: number, name: string): Promise<InstalledFont> {
    const manifest = this.read();
    const known = manifest.fonts.find((f) => f.itemId === itemId);
    if (known && existsSync(known.file)) return known;

    const pid = this.resolvePid();
    if (!pid) {
      throw new Error('下载字体需要登录该账号的 QQ 客户端(字体资源只能通过在线实例换取)');
    }

    const resource = await getFontResource(this.nt, pid, itemId);
    if (!resource?.ok) {
      throw new Error(
        `服务端没有返回该字体的下载地址(${resource?.reason ?? 'unknown'})—— 可能该款已下架`,
      );
    }

    const fontsDir = join(this.rootDir, 'fonts');
    mkdirSync(fontsDir, { recursive: true });
    const zipPath = join(fontsDir, `${itemId}.zip`);
    const outcome = await downloadUrlToFile(resource.url, zipPath);
    if (!outcome.ok) throw new Error(`字体下载失败: ${outcome.reason}`);

    const ttf = extractFirstTtf(readFileSync(zipPath));
    if (!ttf) throw new Error('字体包里没有找到 ttf 文件');

    const file = join(fontsDir, `${itemId}.ttf`);
    writeFileSync(file, ttf);

    const entry: InstalledFont = { itemId, name, family: fontFamilyFor(itemId), file };
    const next = manifest.fonts.filter((f) => f.itemId !== itemId);
    next.push(entry);
    this.write({ ...manifest, fonts: next });

    this.logger.info('installed font', {
      event: 'dress-install-font',
      itemId,
      bytes: ttf.length,
    });
    return entry;
  }

  /** 切换生效的装扮。传 0 表示取消该项。 */
  setActive(kind: 'bubble' | 'font', itemId: number): DressManifest {
    const manifest = this.read();
    const next =
      kind === 'bubble'
        ? { ...manifest, activeBubble: itemId }
        : { ...manifest, activeFont: itemId };
    this.write(next);
    return next;
  }

  /** 切换装扮的作用范围(仅自己 / 所有人)。 */
  setScope(scope: DressScope): DressManifest {
    const next = { ...this.read(), scope };
    this.write(next);
    return next;
  }

  /** 已装字体的 ttf 路径。未装 / 文件丢失时返回 null。 */
  fontFile(itemId: number): string | null {
    const hit = this.read().fonts.find((f) => f.itemId === itemId);
    return hit && existsSync(hit.file) ? hit.file : null;
  }

  /**
   * 已装气泡的本地九宫格 PNG 路径(只有走 protocol 兜底的那些才有)。
   *
   * 供 `weq-media://dressbubble?id=` 用 —— CDN 直链那条走 `weq-media://dress`,
   * 后者的 host 白名单不放行本地文件。
   */
  bubbleFile(itemId: number): string | null {
    const hit = this.read().bubbles.find((b) => b.itemId === itemId);
    return hit?.localFile && existsSync(hit.localFile) ? hit.localFile : null;
  }

  /**
   * 补下自己在 QQ 里正在用的字体。
   *
   * ninebird 登录后 QQ 已被 kill,没有 pid 可发包,所以 bootstrap 只存得下 fontId;
   * 等下次有在线实例时(monitor.harvest)调这里把文件补齐。已装过或没有在线实例时
   * 静默跳过 —— 这是后台补偿任务,不该打扰用户。
   */
  async ensureOwnFont(itemId: number, name: string): Promise<void> {
    if (!itemId || this.fontFile(itemId) || !this.resolvePid()) return;
    try {
      await this.installFont(itemId, name);
    } catch (e) {
      this.logger.warn('failed to backfill own font', {
        event: 'dress-own-font-failed',
        itemId,
        ...logErrorContext(e),
      });
    }
  }
}

/**
 * 从 zip 里解出第一个满足 `match` 的文件。
 *
 * 手写而不是引依赖:装扮资源包实测只用 stored(0) 和 deflate(8) 两种压缩方式,两者 node
 * 的 zlib 都能处理。这里直接扫本地文件头(PK\x03\x04)而不读中央目录 —— 包很小(几十 KB)
 * 且只需要找一个文件,扫一遍最省事。
 *
 * 导出是为了可测(见 test/dress_install.ts):手写的二进制解析必须验两种压缩方式、
 * 目标不在包首位、以及包里根本没有目标的情况。
 */
export function extractFromZip(zip: Buffer, match: (name: string) => boolean): Buffer | null {
  let offset = 0;
  while (offset + 30 <= zip.length) {
    if (zip.readUInt32LE(offset) !== 0x04034b50) break; // 不再是本地文件头
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = zip.toString('utf-8', nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;

    if (match(name)) {
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null; // 没见过的压缩方式,别硬猜
    }
    offset = dataStart + compressedSize;
  }
  return null;
}

/** 从字体包里解出 ttf。 */
export function extractFirstTtf(zip: Buffer): Buffer | null {
  return extractFromZip(zip, (n) => /\.ttf$/i.test(n));
}

/** HEAD 探一个外链是否真实存在。理由同 bubble_skin 的 probeAnimated:不能跟随重定向。 */
async function urlExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * 读 Android `.9.png` 的 `npTc` chunk,取九宫格拉伸点。
 *
 * npTc 布局(大端):`wasDeserialized`(1) + `numXDivs`(1) + `numYDivs`(1) + `numColors`(1)
 * + 两个保留 int32 + `paddingLeft/Right/Top/Bottom`(4×int32) + 保留 int32,
 * 之后是 xDivs / yDivs 数组(各 int32)。第一个 xDiv / yDiv 就是拉伸区的起点,与
 * `immersiveMaterial.zoomPointX/Y` 同义(实测 2078642:xDiv[0]=64 ↔ zoomPointX=65,
 * 差 1 是因为 material 给的是「切片尺寸」而 div 是「0 基起点」)。
 *
 * 解析不出返回 null —— 调用方会回退到量兄弟切片的尺寸。
 */
function readNinePatchZoom(png: Buffer): { x: number; y: number } | null {
  let i = 8;
  while (i + 8 <= png.length) {
    const len = png.readUInt32BE(i);
    const type = png.toString('latin1', i + 4, i + 8);
    if (type === 'npTc') {
      const b = png.subarray(i + 8, i + 8 + len);
      const numXDivs = b.readUInt8(1);
      const numYDivs = b.readUInt8(2);
      if (numXDivs < 1 || numYDivs < 1) return null;
      const divs = 32; // 头部固定 32 字节,之后紧跟 xDivs
      if (b.length < divs + 4 * (numXDivs + 1)) return null;
      const x = b.readInt32BE(divs);
      const y = b.readInt32BE(divs + 4 * numXDivs);
      // material 的 zoomPoint 比 div 起点大 1(切片尺寸 vs 0 基坐标)。
      return x > 0 && y > 0 ? { x: x + 1, y: y + 1 } : null;
    }
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return null;
}
