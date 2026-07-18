/**
 * WebUI 后端：一个零依赖的 node http 服务，随 bot 一起起。
 *
 * 鉴权：导出时生成的 hex 密钥。POST /api/login 校验；其余 /api/* 走 Authorization: Bearer <key>。
 * 用 crypto.timingSafeEqual 做常量时间比较，避免时序侧信道。仅 127.0.0.1 监听（本机）。
 *
 * 路由：
 *   GET  /                 → 内嵌单文件前端（app.html.ts）
 *   POST /api/login        → { ok: boolean }
 *   GET  /api/stats        → StatsSnapshot（token/消息/按天/按模型）
 *   GET  /api/overview     → 训练参数 / 语音 / 表情 / 画像总览（只读）
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLabPersona, AgentLabStickerRef, AgentLabStore, TtsProviderConfig } from '@weq/agentlab';
import type { RuntimeLogger } from '@weq/agentlab';
import type { StatsStore } from '../stats';
import { renderAppHtml } from './app.html';

export interface WebUiDeps {
  port: number;
  /** 访问密钥（hex）。 */
  key: string;
  /** bot 编号（uuid，仅用于展示/日志）。 */
  id: string;
  persona: AgentLabPersona;
  stats: StatsStore;
  /** 功能开关（导出 config.features），总览页展示。 */
  features: { voice: boolean; groupChat: boolean };
  /** TTS providers（拿 provider 名字展示，不返回 key）。 */
  ttsProviders?: TtsProviderConfig[];
  /** persona 存储：上传/删除表情后 savePersona 落盘，runtime 下次对话即读到新表情。 */
  store: AgentLabStore;
  /** 表情图目录（<personaDir>/stickers），GET/POST/DELETE 表情都在这读写。 */
  stickersDir: string;
  /** 有图像模型时用它解析上传的新表情（生成 description/scenario）；无则新表情走「随机发」。 */
  visionDescribe?: (imageDataUrl: string) => Promise<{ description: string; scenario: string }>;
  /** 完全重载回调（重读 config.json 并重建实例）。缺省则 /api/reload 返回 501。 */
  onReload?: () => Promise<{ ok: boolean; message?: string }>;
  logger?: RuntimeLogger;
}

/** /api/overview 返回结构（全部只读，绝不含任何 apiKey / token）。 */
interface OverviewPayload {
  persona: { name: string; sourceKind: string; sourceTitle: string };
  corpus: {
    corpusMessageCount: number;
    pairCount: number;
    corpusChars: number;
    avgFriendMsgChars: number;
  };
  models: { chat: string; embedding?: string; vision?: string };
  willing: { level: number; mustReplyOnMention: boolean; gatePrivate: boolean };
  features: { voice: boolean; groupChat: boolean };
  voice: { cloneEnabled: boolean; provider?: string; mode?: string; voiceRatio: number };
  assets: { stickerCount: number; systemFaceCount: number };
  profile: { styleSummary: string; topTerms: string[]; relationshipSummary: string };
}

function buildOverview(deps: WebUiDeps): OverviewPayload {
  const p = deps.persona;
  const providerName = p.voice?.providerId
    ? deps.ttsProviders?.find((t) => t.id === p.voice?.providerId)?.name ?? p.voice.providerId
    : undefined;
  return {
    persona: { name: p.name, sourceKind: p.sourceKind, sourceTitle: p.sourceTitle },
    corpus: {
      corpusMessageCount: p.corpusMessageCount ?? p.stats?.sourceMessageCount ?? 0,
      pairCount: p.pairCount ?? p.stats?.pairCount ?? 0,
      corpusChars: p.stats?.corpusChars ?? 0,
      avgFriendMsgChars: Math.round(p.stats?.avgFriendMsgChars ?? 0),
    },
    models: {
      chat: p.models?.chat?.model ?? '',
      embedding: p.models?.embedding?.model,
      vision: p.models?.vision?.model,
    },
    willing: {
      level: p.willing?.level ?? 50,
      mustReplyOnMention: p.willing?.mustReplyOnMention !== false,
      gatePrivate: !!p.willing?.gatePrivate,
    },
    features: { voice: deps.features.voice, groupChat: deps.features.groupChat },
    voice: {
      cloneEnabled: !!p.voiceCloneEnabled,
      provider: providerName,
      mode: p.voice?.mode,
      voiceRatio: p.voiceProfile?.ratio ?? p.profile?.voiceRatio ?? 0,
    },
    assets: {
      stickerCount: p.stickers?.length ?? 0,
      systemFaceCount: p.systemFaces?.length ?? 0,
    },
    profile: {
      styleSummary: p.profile?.styleSummary ?? '',
      topTerms: p.profile?.topTerms ?? [],
      relationshipSummary: p.profile?.relationshipSummary ?? '',
    },
  };
}

/** 表情列表（只读展示；described=有文字说明，能被 LLM 按语义精准选，否则走随机发）。 */
function listStickers(persona: AgentLabPersona): Array<{
  md5: string;
  description: string;
  scenario: string;
  count: number;
  described: boolean;
}> {
  return (persona.stickers ?? []).map((s) => ({
    md5: s.md5,
    description: s.description ?? '',
    scenario: s.scenario ?? '',
    count: s.count ?? 0,
    described: !!(s.description || s.scenario),
  }));
}

/** data URL（data:image/png;base64,xxx 或裸 base64）→ Buffer。非法返回 null。 */
function dataUrlToBuffer(dataUrl: string): Buffer | null {
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(dataUrl.trim());
  const b64 = m ? m[1]! : /^[A-Za-z0-9+/=\s]+$/.test(dataUrl.trim()) ? dataUrl.trim() : null;
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** 常量时间比较（长度不同直接 false，长度相同才 timingSafeEqual）。 */
function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization;
  if (!h || Array.isArray(h)) return '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk.toString('utf-8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export interface WebUiHandle {
  close(): void;
  port: number;
}

/** 启动 WebUI。返回 { close }。监听失败（端口占用）不抛，只记日志并返回可 no-op 的 handle。 */
export function startWebUi(deps: WebUiDeps): Promise<WebUiHandle> {
  const html = renderAppHtml(deps.persona.name || 'WeQ Bot');
  const log = deps.logger;

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url || '/').split('?')[0] ?? '/';
    const method = req.method || 'GET';

    // 页面
    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // 登录
    if (method === 'POST' && url === '/api/login') {
      let key = '';
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}') as { key?: unknown };
        key = typeof parsed.key === 'string' ? parsed.key : '';
      } catch {
        /* 忽略解析错误，当作空 key */
      }
      sendJson(res, 200, { ok: keyMatches(key, deps.key) });
      return;
    }

    // 表情图（二进制）：<img> 标签不能带 Authorization 头，改用 query ?k=<key> 鉴权。仅本机，安全性够用。
    // 路径 /api/sticker/<md5>。md5 强校验（仅 hex），杜绝路径穿越。
    if (method === 'GET' && url.startsWith('/api/sticker/')) {
      const q = new URL(req.url || '/', 'http://127.0.0.1');
      if (!keyMatches(q.searchParams.get('k') || '', deps.key)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const md5 = url.slice('/api/sticker/'.length);
      if (!/^[0-9a-fA-F]{6,64}$/.test(md5)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const file = join(deps.stickersDir, `${md5}.png`);
      if (!existsSync(file)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(readFileSync(file));
      return;
    }

    // 受保护 API
    if (url.startsWith('/api/')) {
      if (!keyMatches(bearer(req), deps.key)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (method === 'GET' && url === '/api/stats') {
        sendJson(res, 200, deps.stats.snapshot());
        return;
      }
      if (method === 'GET' && url === '/api/overview') {
        sendJson(res, 200, buildOverview(deps));
        return;
      }
      // 表情列表。
      if (method === 'GET' && url === '/api/stickers') {
        sendJson(res, 200, { stickers: listStickers(deps.persona), canDescribe: !!deps.visionDescribe });
        return;
      }
      // 上传新表情：body { dataUrl } → 存 <md5>.png → 追加/更新 persona.stickers → 有图像模型则解析一次 → savePersona。
      if (method === 'POST' && url === '/api/stickers') {
        let dataUrl = '';
        try {
          const parsed = JSON.parse((await readBody(req, 8 * 1024 * 1024)) || '{}') as { dataUrl?: unknown };
          dataUrl = typeof parsed.dataUrl === 'string' ? parsed.dataUrl : '';
        } catch {
          sendJson(res, 400, { error: '请求体过大或格式错误' });
          return;
        }
        const buf = dataUrlToBuffer(dataUrl);
        if (!buf) {
          sendJson(res, 400, { error: '不是有效的图片数据' });
          return;
        }
        const md5 = createHash('md5').update(buf).digest('hex').toUpperCase();
        mkdirSync(deps.stickersDir, { recursive: true });
        writeFileSync(join(deps.stickersDir, `${md5}.png`), buf);

        const stickers = deps.persona.stickers ?? [];
        deps.persona.stickers = stickers;
        let ref = stickers.find((s) => s.md5.toUpperCase() === md5);
        if (!ref) {
          ref = {
            md5,
            fileName: `${md5}.png`,
            localPath: join('stickers', `${md5}.png`),
            cdnToken: '',
            count: 0,
            description: '',
            scenario: '',
            contexts: [],
          } satisfies AgentLabStickerRef;
          stickers.push(ref);
        }
        // 有图像模型则解析一次内容/场景（失败不阻断，留空走随机发）。
        if (deps.visionDescribe) {
          try {
            const d = await deps.visionDescribe(dataUrl);
            ref.description = d.description || '';
            ref.scenario = d.scenario || '';
          } catch (err) {
            deps.logger?.warn(`表情解析失败（将走随机发）：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // 落盘（保留原 pairs）。
        const rec = deps.store.getPersona(deps.persona.id);
        deps.store.savePersona({ persona: deps.persona, pairs: rec?.pairs ?? [] });
        sendJson(res, 200, {
          ok: true,
          sticker: {
            md5: ref.md5,
            description: ref.description,
            scenario: ref.scenario,
            count: ref.count,
            described: !!(ref.description || ref.scenario),
          },
        });
        return;
      }
      // 删除表情：/api/stickers/<md5>。
      if (method === 'DELETE' && url.startsWith('/api/stickers/')) {
        const md5 = url.slice('/api/stickers/'.length);
        if (!/^[0-9a-fA-F]{6,64}$/.test(md5)) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        const stickers = deps.persona.stickers ?? [];
        const idx = stickers.findIndex((s) => s.md5.toUpperCase() === md5.toUpperCase());
        if (idx < 0) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        const removed = stickers[idx]!;
        stickers.splice(idx, 1);
        deps.persona.stickers = stickers;
        try {
          unlinkSync(join(deps.stickersDir, `${removed.md5}.png`));
        } catch {
          /* 文件可能已不在，忽略 */
        }
        const rec = deps.store.getPersona(deps.persona.id);
        deps.store.savePersona({ persona: deps.persona, pairs: rec?.pairs ?? [] });
        sendJson(res, 200, { ok: true });
        return;
      }
      // 完全重载：重读 config.json 并重建实例。注意——本 http server 会随实例一起重启，
      // 故先把响应发出去，再触发重载（否则响应会随 server 关闭而丢失）。
      if (method === 'POST' && url === '/api/reload') {
        if (!deps.onReload) {
          sendJson(res, 501, { ok: false, message: '当前实例不支持重载' });
          return;
        }
        sendJson(res, 200, { ok: true, message: '已触发重载，稍后自动用新配置上线' });
        setTimeout(() => {
          void deps.onReload!().catch((err) => {
            deps.logger?.error(`重载执行失败：${err instanceof Error ? err.message : String(err)}`);
          });
        }, 120);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  return new Promise((resolve) => {
    server.on('error', (err) => {
      log?.error(`WebUI 启动失败（端口 ${deps.port}）：${err instanceof Error ? err.message : String(err)}`);
      resolve({ close: () => undefined, port: deps.port });
    });
    server.listen(deps.port, '127.0.0.1', () => {
      log?.info(`WebUI 已启动：http://127.0.0.1:${deps.port} （bot 编号 ${deps.id}）`);
      resolve({
        close: () => server.close(),
        port: deps.port,
      });
    });
  });
}
