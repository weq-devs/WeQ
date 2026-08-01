/**
 * LinkPreviewService —— 聊天里的裸链接 → 一张卡片（标题/描述/站点/封面图）。
 *
 * 这是本仓库里唯一一处「拿用户消息里的字符串去发网络请求」的地方，所以整条链路是按
 * 「默认不信任」写的，四道闸依次是：
 *
 *   1. **协议 / 端口**：只放行 http(s)，且只放行 80/443。攻击者没法用
 *      `http://127.0.0.1:6379/` 之类去捅本机服务。
 *   2. **地址**：域名先自己解析一遍，解析出的**每一个** A/AAAA 都必须是公网地址
 *      —— 回环 / 私网 / link-local / 云元数据 (169.254.169.254) / CGNAT / 组播 全拒。
 *      校验过的那个 IP 会被**钉进 socket**（见 {@link pinnedRequest}），所以「校验的」
 *      和「真正连上的」必是同一个地址，DNS rebinding 也钻不进来。重定向手动一跳一跳
 *      走、每跳各自过闸并各自钉 IP，堵掉「公网 URL 302 到内网」这条经典绕过。
 *   3. **内容类型**：正文只接受 text/html，图片只接受 image/* 且再验一次文件魔数。
 *      服务端返回 exe/zip/dmg 时我们**根本不会去取它的 body**——「自动下载木马」
 *      在这一层就不成立（也不落盘、更不执行）。SVG 明确拒收（它能带脚本）。
 *   4. **规模**：正文 512KB 封顶、单请求 8s 超时、重定向 ≤5 跳。超了直接放弃。
 *
 * 拿到的结果（含封面图字节）按 URL 落盘缓存，命中就不再出网；失败也缓存（短 TTL），
 * 免得一条打不开的链接每次滚动到都重新发一次请求。
 *
 * 抓不到图时可以退到「网页预截图」：截图本身需要一个浏览器，服务层不该知道 Electron，
 * 所以留成 {@link setScreenshotHook} 由 app 层注入（见 apps/desktop/src/main/link_shot.ts）。
 */

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { getLogger } from '../common/logger';
import type { UserConfigService } from './user_config';

/** 一条链接的预览结果。`image`/`favicon` 是本地缓存 id，渲染层拼成 weq-media://linkpreview?id=…。 */
export interface LinkPreview {
  /** 跟完重定向后的最终地址（卡片点击就跳这个）。 */
  url: string;
  title: string;
  desc: string;
  siteName: string;
  /** 封面图的本地缓存 id；空串表示没图。 */
  image: string;
  /** 封面图来源：og = 页面自己给的，shot = 我们截的。 */
  imageKind: 'og' | 'shot' | '';
  fetchedAt: number;
}

/** 网页预截图钩子（app 层注入）；返回 PNG 字节，失败返回 null。 */
export type ScreenshotHook = (url: string) => Promise<Buffer | null>;

interface CacheEntry {
  preview: LinkPreview | null;
  fetchedAt: number;
}

const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 30 * 60 * 1000;
const HTML_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 4 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
/** 微信公众号文章对 UA 挑食：非微信 UA 会被打到「请在微信客户端打开」的空壳页。 */
const WECHAT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351';

function uaFor(host: string): string {
  return host === 'mp.weixin.qq.com' || host.endsWith('.weixin.qq.com') ? WECHAT_UA : DESKTOP_UA;
}

// ---- SSRF 闸门 -------------------------------------------------------------

function ipv4Blocked(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 127) return true; // 本机 / 未指定
  if (a === 10) return true; // 私网
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 169 && b === 254) return true; // link-local（含 169.254.169.254 云元数据）
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24 IETF、192.0.2/24 文档网
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网
  if (a >= 224) return true; // 组播 / 保留 / 广播
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const s = ip.toLowerCase().split('%')[0]!;
  // IPv4-mapped / IPv4-compatible（::ffff:127.0.0.1 是最常见的绕过写法）
  const mapped = s.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]!);
  if (s === '::' || s === '::1') return true;
  const head = s.split(':')[0] ?? '';
  const n = Number.parseInt(head || '0', 16);
  if ((n & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((n & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((n & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (s.startsWith('64:ff9b:')) return true; // NAT64 → 可映射到内网 v4
  return false;
}

function ipBlocked(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true;
}

/** 过闸结果：允许出网的 URL + 校验通过、连接时**必须**使用的那个 IP。 */
interface Allowed {
  url: URL;
  /** 钉死的目标地址。连接层只准连它，不再让系统二次解析（封死 DNS rebinding）。 */
  ip: string;
}

/**
 * 一个 URL 是否允许出网：协议 http(s)、端口 80/443、且主机解析出的**全部**地址都是公网。
 *
 * 返回值带上选中的 IP —— 校验和连接之间若再解析一次，攻击者控制的 DNS 可以第一次答
 * 公网、第二次答 127.0.0.1（DNS rebinding）。所以这里把校验过的地址交给调用方钉进
 * socket（见 {@link pinnedRequest}），让「校验的」和「连上的」是同一个地址。
 */
async function urlAllowed(raw: string): Promise<Allowed | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return ipBlocked(host) ? null : { url: u, ip: host };
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    if (addrs.length === 0) return null;
    // 全部地址都必须干净：只要有一个是内网，这个域名整个不可信。
    if (addrs.some((a) => ipBlocked(a.address))) return null;
    return { url: u, ip: addrs[0]!.address };
  } catch {
    return null;
  }
}

/**
 * 发一个请求，强制连到 `target.ip`（而不是让系统重新解析主机名）。
 *
 * 用 node:http(s) 而非 fetch，只因为 fetch 不给我们插手地址解析的口子。TLS 的
 * `servername` 和 `Host` 头仍按原主机名发，所以 SNI / 虚拟主机 / 证书校验一切照常，
 * 唯一被固定的是「连哪个 IP」。
 */
function pinnedRequest(
  target: Allowed,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; stream: IncomingMessage }> {
  const { url, ip } = target;
  const https = url.protocol === 'https:';
  const options = {
    protocol: url.protocol,
    host: url.hostname,
    servername: https ? url.hostname : undefined,
    port: url.port || (https ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    headers: { ...headers, Host: url.host },
    timeout: TIMEOUT_MS,
    // 连接层的钉子：无视传入的 hostname，直接给校验过的那个 IP。node 的 agent 用
    // `all: true` 调 lookup，所以回调必须回数组形态（回三参数会 Invalid IP address）。
    lookup: (
      _host: string,
      _opts: unknown,
      cb: (e: Error | null, addrs: { address: string; family: number }[]) => void,
    ) => {
      cb(null, [{ address: ip, family: isIP(ip) }]);
    },
  };
  return new Promise((resolve, reject) => {
    const req = (https ? httpsRequest : httpRequest)(options as never, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
    });
    req.on('timeout', () => req.destroy(new Error('link preview timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** 一次过闸请求的结果（把 node stream 包成我们后面要用的最小形状）。 */
interface GuardedHit {
  status: number;
  contentType: string;
  stream: Readable;
  url: URL;
}

/**
 * 按 Content-Encoding 套一层解压。
 *
 * 裸 node:http 不像 fetch 那样自动解压，而且不少站点（B站就是）无视我们发的
 * `Accept-Encoding: identity` 照样回 gzip —— 不解压就只能拿到一堆压缩字节，正则一个
 * 也匹配不到。解压流同样受调用方的字节上限约束（读够就 destroy）。
 */
function decompress(stream: IncomingMessage): Readable {
  switch ((stream.headers['content-encoding'] ?? '').toString().toLowerCase()) {
    case 'gzip':
      return stream.pipe(createGunzip());
    case 'deflate':
      return stream.pipe(createInflate());
    case 'br':
      return stream.pipe(createBrotliDecompress());
    default:
      return stream;
  }
}

/**
 * 逐跳跟随重定向，每跳都重新过 {@link urlAllowed}（并各自钉住自己那一跳的 IP）。
 * 任何一跳越界（内网 / 非 http / 怪端口）整条链路作废。
 */
async function guardedFetch(start: Allowed, accept: string): Promise<GuardedHit | null> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await pinnedRequest(current, {
      'User-Agent': uaFor(current.url.hostname),
      Accept: accept,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    });
    if (res.status < 300 || res.status >= 400) {
      const ct = res.headers['content-type'];
      return {
        status: res.status,
        contentType: Array.isArray(ct) ? (ct[0] ?? '') : (ct ?? ''),
        stream: decompress(res.stream),
        url: current.url,
      };
    }
    const location = res.headers.location;
    res.stream.destroy();
    if (!location || Array.isArray(location)) return null;
    const next = await urlAllowed(new URL(location, current.url).toString());
    if (!next) return null;
    current = next;
  }
  return null;
}

/**
 * 读响应流，最多读 `limit` 字节就掐断连接。
 *
 * 是**截断**而不是放弃：og / twitter / msg_* 这些元信息全在 `<head>` 附近（公众号文章
 * 整页 3MB+，og 标签在头 20KB 内），为了正文没读完就丢掉整个页面等于白抓。
 */
async function readCapped(stream: Readable, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    total += (chunk as Buffer).byteLength;
    if (total >= limit) break;
  }
  stream.destroy();
  return chunks.length > 0 ? Buffer.concat(chunks).subarray(0, limit) : null;
}

/** 整读一个响应，超过上限直接放弃。图片不能截断——半张图解不出来。 */
async function readWhole(stream: Readable, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).byteLength;
    if (total > limit) {
      stream.destroy();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

// ---- HTML 元信息解析 -------------------------------------------------------

/** 按 content-type / `<meta charset>` 解码正文（不少中文站点仍是 gbk）。 */
function decodeHtml(bytes: Buffer, contentType: string): string {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  const sniff = bytes.subarray(0, 2048).toString('latin1');
  const fromMeta =
    sniff.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ??
    sniff.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i)?.[1];
  const label = (fromHeader || fromMeta || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label === 'gb2312' ? 'gbk' : label).decode(bytes);
  } catch {
    return bytes.toString('utf-8');
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

function unescapeHtml(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? _)
    .replace(/&#(\d{1,6});/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)));
}

function clean(s: string, max: number): string {
  const t = unescapeHtml(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** `<meta>` 表：property/name（小写）→ content。用逐标签扫描，避免大回溯正则。 */
function metaTable(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1];
    const val = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (key && val && !out.has(key.toLowerCase())) out.set(key.toLowerCase(), val);
  }
  return out;
}

/** 公众号文章的字段藏在内联脚本里（`var msg_title = "…"`），og 标签常常是空的。 */
function wechatVar(html: string, name: string): string {
  const m = html.match(new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]{0,600}?)\\1`));
  return m ? m[2]!.replace(/\\x26amp;/g, '&').replace(/\\x26/g, '&').replace(/\\\//g, '/') : '';
}

/**
 * 公众号名。页面里那个 `id="js_name"` 锚点在 600KB 开外（超出我们的正文截断上限），
 * 但 head 里的 `og:article:author` 是同一个值，就在头 20KB —— 用它。
 */
function wechatAuthor(meta: Map<string, string>): string {
  return meta.get('og:article:author') ?? meta.get('author') ?? '';
}

function parseMeta(html: string, pageUrl: URL): Omit<LinkPreview, 'image' | 'imageKind' | 'fetchedAt'> & {
  imageUrl: string;
} {
  const meta = metaTable(html);
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = meta.get(k);
      if (v?.trim()) return v;
    }
    return '';
  };
  const isWechat = pageUrl.hostname.endsWith('weixin.qq.com');
  const title =
    pick('og:title', 'twitter:title') ||
    (isWechat ? wechatVar(html, 'msg_title') : '') ||
    html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] ||
    '';
  const desc =
    pick('og:description', 'twitter:description', 'description') ||
    (isWechat ? wechatVar(html, 'msg_desc') : '');
  const imageRaw =
    pick('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src') ||
    (isWechat ? wechatVar(html, 'msg_cdn_url') : '');
  // 公众号：og:site_name 恒为「微信公众平台」，作者名（= 公众号名）信息量大得多，优先它。
  const siteName =
    (isWechat ? wechatAuthor(meta) : '') ||
    pick('og:site_name', 'application-name') ||
    pageUrl.hostname.replace(/^www\./, '');

  let imageUrl = '';
  if (imageRaw) {
    try {
      imageUrl = new URL(unescapeHtml(imageRaw.trim()), pageUrl).toString();
    } catch {
      imageUrl = '';
    }
  }
  return {
    url: pageUrl.toString(),
    title: clean(title, 90),
    desc: clean(desc, 160),
    siteName: clean(siteName, 30),
    imageUrl,
  };
}

// ---- 图片校验 --------------------------------------------------------------

/** 魔数 → 扩展名。声明的 content-type 不可信，字节说了算；SVG 不在表里 = 一律拒收。 */
function imageExt(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null;
}

// ---- 服务 ------------------------------------------------------------------

export class LinkPreviewService {
  private readonly memory = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<LinkPreview | null>>();
  private screenshot: ScreenshotHook | null = null;
  private readonly logger = getLogger().child({ scope: 'link-preview' });

  constructor(private readonly userConfig: UserConfigService) {}

  /** 由 app 层注入「网页预截图」实现（Electron 离屏窗口）。 */
  setScreenshotHook(hook: ScreenshotHook | null): void {
    this.screenshot = hook;
  }

  private dir(): string {
    return this.userConfig.cacheDir('linkpreview');
  }

  private key(url: string): string {
    return createHash('sha1').update(url).digest('hex');
  }

  /** 取一条链接的预览。命中缓存不出网；不可预览 / 抓取失败返回 null。 */
  async get(rawUrl: string): Promise<LinkPreview | null> {
    const url = rawUrl.trim();
    if (!url) return null;

    const cached = this.memory.get(url) ?? (await this.readDisk(url));
    if (cached) {
      const ttl = cached.preview ? OK_TTL_MS : FAIL_TTL_MS;
      if (Date.now() - cached.fetchedAt < ttl) {
        this.memory.set(url, cached);
        return cached.preview;
      }
    }

    const running = this.inFlight.get(url);
    if (running) return running;

    const promise = this.fetchPreview(url)
      .catch((error) => {
        this.logger.debug('link preview failed', { event: 'link-preview-fail', url, error: String(error) });
        return null;
      })
      .then(async (preview) => {
        const entry: CacheEntry = { preview, fetchedAt: Date.now() };
        this.memory.set(url, entry);
        await this.writeDisk(url, entry);
        return preview;
      })
      .finally(() => {
        this.inFlight.delete(url);
      });
    this.inFlight.set(url, promise);
    return promise;
  }

  /** 读一张已缓存的封面图（渲染层通过 weq-media://linkpreview?id=… 取）。 */
  async readImage(id: string): Promise<{ data: Buffer; contentType: string } | null> {
    if (!/^[0-9a-f]{40}\.(jpg|png|gif|webp|bmp)$/.test(id)) return null;
    try {
      const data = await readFile(join(this.dir(), id));
      const ext = id.split('.').pop()!;
      return { data, contentType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` };
    } catch {
      return null;
    }
  }

  private async readDisk(url: string): Promise<CacheEntry | null> {
    try {
      const raw = await readFile(join(this.dir(), `${this.key(url)}.json`), 'utf-8');
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }

  private async writeDisk(url: string, entry: CacheEntry): Promise<void> {
    try {
      const dir = this.dir();
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${this.key(url)}.json`), JSON.stringify(entry), 'utf-8');
    } catch {
      // 缓存写失败不该让预览失败——下次重新抓就是了。
    }
  }

  private async fetchPreview(rawUrl: string): Promise<LinkPreview | null> {
    const start = await urlAllowed(rawUrl);
    if (!start) return null;

    const hit = await guardedFetch(start, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
    if (hit?.status !== 200) {
      hit?.stream.destroy();
      return null;
    }
    // 只解析网页。对方给的是安装包 / 压缩包 / 任何二进制时，body 我们碰都不碰。
    if (!/^\s*(?:text\/html|application\/xhtml\+xml)/i.test(hit.contentType)) {
      hit.stream.destroy();
      return null;
    }
    const bytes = await readCapped(hit.stream, HTML_LIMIT);
    if (!bytes) return null;

    const parsed = parseMeta(decodeHtml(bytes, hit.contentType), hit.url);
    if (!parsed.title && !parsed.desc && !parsed.imageUrl) return null;

    let image = parsed.imageUrl ? await this.cacheImage(parsed.imageUrl) : '';
    let imageKind: LinkPreview['imageKind'] = image ? 'og' : '';
    if (!image && this.screenshot && this.userConfig.getSettings().linkPreview.screenshot) {
      image = await this.cacheShot(hit.url.toString());
      if (image) imageKind = 'shot';
    }

    return {
      url: parsed.url,
      title: parsed.title,
      desc: parsed.desc,
      siteName: parsed.siteName,
      image,
      imageKind,
      fetchedAt: Date.now(),
    };
  }

  /** 抓一张封面图并落盘。返回缓存 id；任何一步不达标返回空串。 */
  private async cacheImage(rawUrl: string): Promise<string> {
    const target = await urlAllowed(rawUrl);
    if (!target) return '';
    try {
      const hit = await guardedFetch(
        target,
        'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      );
      if (hit?.status !== 200) {
        hit?.stream.destroy();
        return '';
      }
      if (!/^\s*image\//i.test(hit.contentType)) {
        hit.stream.destroy();
        return '';
      }
      const bytes = await readWhole(hit.stream, IMAGE_LIMIT);
      if (!bytes) return '';
      const ext = imageExt(bytes);
      if (!ext) return '';
      return await this.store(`${this.key(rawUrl)}.${ext}`, bytes);
    } catch {
      return '';
    }
  }

  /** 没有 og:image 时，请 app 层截一张网页图。 */
  private async cacheShot(url: string): Promise<string> {
    try {
      const png = await this.screenshot?.(url);
      if (!png || imageExt(png) !== 'png') return '';
      return await this.store(`${this.key(`shot:${url}`)}.png`, png);
    } catch {
      return '';
    }
  }

  private async store(name: string, bytes: Buffer): Promise<string> {
    const dir = this.dir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), bytes);
    return name;
  }
}
