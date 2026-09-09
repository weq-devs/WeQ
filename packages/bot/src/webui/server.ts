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
 *   GET  /api/config       → 产物 config.json（apiKey 打码，只读展示）
 *   PUT  /api/config       → 白名单字段写回 config.json（打码 key 视为未修改）；改后需 /api/reload 生效
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentLabPersona,
  AgentLabStickerRef,
  AgentLabStore,
  TtsProviderConfig,
} from '@weq/agentlab';
import type { RuntimeLogger } from '@weq/agentlab';
import type { BotConfig } from '../config';
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
  /** 产物 config.json 的绝对路径。提供后 WebUI 才能读写配置（/api/config）。 */
  configPath?: string;
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
    ? (deps.ttsProviders?.find((t) => t.id === p.voice?.providerId)?.name ?? p.voice.providerId)
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

/**
 * API key 打码：只露头 3 + 尾 4，中间用 • 填充。含 • 的值回传时视为「未修改」，落盘前还原成原值。
 */
function maskKey(k: string | undefined): string {
  const s = k ?? '';
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 3)}••••${s.slice(-4)}`;
}

/** 读产物 config.json（每次现读——它是配置的唯一事实源）。失败返回 null。 */
function readConfigFile(configPath: string): BotConfig | null {
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as BotConfig;
  } catch {
    return null;
  }
}

/** /api/config GET 的返回结构：可编辑字段 + 打码 key。绝不返回明文 apiKey。 */
function buildConfigPayload(cfg: BotConfig): unknown {
  return {
    adapter: {
      type: cfg.adapter.type,
      wsUrl: cfg.adapter.wsUrl,
      token: cfg.adapter.token ?? '',
    },
    selfId: cfg.selfId,
    features: {
      voice: cfg.features?.voice ?? false,
      groupChat: cfg.features?.groupChat ?? false,
      groupReplyMode: cfg.features?.groupReplyMode ?? 'llm',
    },
    webui: {
      enabled: cfg.webui?.enabled !== false,
      port: cfg.webui?.port ?? 8090,
    },
    llmProviders: (cfg.llmProviders ?? []).map((p) => ({
      id: p.id,
      baseUrl: p.baseUrl,
      apiKey: maskKey(p.apiKey),
    })),
    ttsProviders: (cfg.ttsProviders ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      vendor: p.vendor,
      baseUrl: p.baseUrl,
      apiKey: maskKey(p.apiKey),
    })),
  };
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
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
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

/**
 * 把 /api/config PUT 的 body 合并进现读的 config（就地修改 cfg）。
 * 规则：只动白名单字段；apiKey 含 •（打码）则保留原值，否则视为新 key。返回错误文案或 null。
 */
function applyConfigPatch(cfg: BotConfig, body: Record<string, unknown>): string | null {
  // adapter
  const ad = body.adapter as Record<string, unknown> | undefined;
  if (ad !== undefined) {
    if (typeof ad !== 'object' || ad === null) return 'adapter 格式错误';
    const type = ad.type;
    if (type !== undefined && type !== 'napcat' && type !== 'snowluma')
      return 'adapter.type 只能是 napcat 或 snowluma';
    if (type !== undefined) cfg.adapter.type = type;
    if (ad.wsUrl !== undefined) {
      if (typeof ad.wsUrl !== 'string' || !/^wss?:\/\/.+/.test(ad.wsUrl.trim())) {
        return 'wsUrl 必须是 ws:// 或 wss:// 开头的地址';
      }
      cfg.adapter.wsUrl = ad.wsUrl.trim();
    }
    if (ad.token !== undefined) {
      if (typeof ad.token !== 'string') return 'token 格式错误';
      cfg.adapter.token = ad.token.trim();
    }
  }
  // features
  const ft = body.features as Record<string, unknown> | undefined;
  if (ft !== undefined) {
    if (typeof ft !== 'object' || ft === null) return 'features 格式错误';
    cfg.features = cfg.features ?? {};
    if (ft.voice !== undefined) {
      if (typeof ft.voice !== 'boolean') return 'features.voice 必须是布尔值';
      cfg.features.voice = ft.voice;
    }
    if (ft.groupChat !== undefined) {
      if (typeof ft.groupChat !== 'boolean') return 'features.groupChat 必须是布尔值';
      cfg.features.groupChat = ft.groupChat;
    }
    if (ft.groupReplyMode !== undefined) {
      if (ft.groupReplyMode !== 'llm' && ft.groupReplyMode !== 'heuristic') {
        return 'features.groupReplyMode 只能是 llm 或 heuristic';
      }
      cfg.features.groupReplyMode = ft.groupReplyMode;
    }
  }
  // webui
  const wu = body.webui as Record<string, unknown> | undefined;
  if (wu !== undefined) {
    if (typeof wu !== 'object' || wu === null) return 'webui 格式错误';
    cfg.webui = cfg.webui ?? { key: '', id: '' };
    if (wu.enabled !== undefined) {
      if (typeof wu.enabled !== 'boolean') return 'webui.enabled 必须是布尔值';
      cfg.webui.enabled = wu.enabled;
    }
    if (wu.port !== undefined) {
      const n = Number(wu.port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return 'webui.port 必须是 1~65535 的整数';
      cfg.webui.port = n;
    }
  }
  // selfId：bot 自己的 QQ 号（纯数字），改后需重载生效。
  if (body.selfId !== undefined) {
    if (typeof body.selfId !== 'string' || !/^\d{5,}$/.test(body.selfId.trim())) {
      return 'selfId 必须是 QQ 号（5 位以上纯数字）';
    }
    cfg.selfId = body.selfId.trim();
  }
  // llmProviders：只允许改 baseUrl/apiKey（id 是 persona.models 的引用键，不可改）。
  const llm = body.llmProviders as Array<Record<string, unknown>> | undefined;
  if (llm !== undefined) {
    if (!Array.isArray(llm)) return 'llmProviders 格式错误';
    for (const item of llm) {
      const p = cfg.llmProviders.find((x) => x.id === item?.id);
      if (!p) return `llmProviders 里没有 id 为 ${String(item?.id)} 的 provider`;
      if (item.baseUrl !== undefined) {
        if (typeof item.baseUrl !== 'string' || !/^https?:\/\//.test(item.baseUrl.trim())) {
          return `provider ${p.id} 的 baseUrl 必须是 http(s):// 开头`;
        }
        p.baseUrl = item.baseUrl.trim();
      }
      if (
        item.apiKey !== undefined &&
        typeof item.apiKey === 'string' &&
        !item.apiKey.includes('•')
      ) {
        p.apiKey = item.apiKey.trim();
      }
    }
  }
  // ttsProviders：同样只允许改 baseUrl/apiKey。
  const tts = body.ttsProviders as Array<Record<string, unknown>> | undefined;
  if (tts !== undefined) {
    if (!Array.isArray(tts)) return 'ttsProviders 格式错误';
    cfg.ttsProviders = cfg.ttsProviders ?? [];
    for (const item of tts) {
      const p = cfg.ttsProviders.find((x) => x.id === item?.id);
      if (!p) return `ttsProviders 里没有 id 为 ${String(item?.id)} 的 provider`;
      if (item.baseUrl !== undefined) {
        if (typeof item.baseUrl !== 'string' || !/^https?:\/\//.test(item.baseUrl.trim())) {
          return `TTS provider ${p.id} 的 baseUrl 必须是 http(s):// 开头`;
        }
        p.baseUrl = item.baseUrl.trim();
      }
      if (
        item.apiKey !== undefined &&
        typeof item.apiKey === 'string' &&
        !item.apiKey.includes('•')
      ) {
        p.apiKey = item.apiKey.trim();
      }
    }
  }
  return null;
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
        sendJson(res, 200, {
          stickers: listStickers(deps.persona),
          canDescribe: !!deps.visionDescribe,
        });
        return;
      }
      // 上传新表情：body { dataUrl } → 存 <md5>.png → 追加/更新 persona.stickers → 有图像模型则解析一次 → savePersona。
      if (method === 'POST' && url === '/api/stickers') {
        let dataUrl = '';
        try {
          const parsed = JSON.parse((await readBody(req, 8 * 1024 * 1024)) || '{}') as {
            dataUrl?: unknown;
          };
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
            deps.logger?.warn(
              `表情解析失败（将走随机发）：${err instanceof Error ? err.message : String(err)}`,
            );
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
      // 读配置（打码 key）。未提供 configPath（如内存态使用）则 404。
      if (method === 'GET' && url === '/api/config') {
        if (!deps.configPath) {
          sendJson(res, 404, { error: '当前实例未挂载 config.json' });
          return;
        }
        const cfg = readConfigFile(deps.configPath);
        if (!cfg) {
          sendJson(res, 500, { error: 'config.json 读取失败' });
          return;
        }
        sendJson(res, 200, buildConfigPayload(cfg));
        return;
      }
      // 写配置：接受 buildConfigPayload 同构的 body，打码 key 原样回传视为未修改（还原原值），
      // 非打码值视为用户改动。写入成功后提示前端走 /api/reload 生效（本进程不热改运行态）。
      if (method === 'PUT' && url === '/api/config') {
        if (!deps.configPath) {
          sendJson(res, 404, { error: '当前实例未挂载 config.json' });
          return;
        }
        const cfg = readConfigFile(deps.configPath);
        if (!cfg) {
          sendJson(res, 500, { error: 'config.json 读取失败，无法在其基础上修改' });
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}') as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { error: '请求体不是合法 JSON' });
          return;
        }
        const err = applyConfigPatch(cfg, body);
        if (err) {
          sendJson(res, 400, { error: err });
          return;
        }
        try {
          writeFileSync(deps.configPath, JSON.stringify(cfg, null, 2), 'utf-8');
        } catch (e) {
          sendJson(res, 500, {
            error: `config.json 写入失败：${e instanceof Error ? e.message : String(e)}`,
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          message: '已保存到 config.json。点「保存并重载」或手动重载后生效。',
        });
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
      log?.error(
        `WebUI 启动失败（端口 ${deps.port}）：${err instanceof Error ? err.message : String(err)}`,
      );
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
