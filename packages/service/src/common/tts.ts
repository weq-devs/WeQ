/**
 * TtsService — account-independent text-to-speech, the second member of
 * `common/`. Mirrors the MaiBot `tts_voice_plugin` strategy pattern: a vendor
 * registry where each backend only knows how to "build a request + decode the
 * response into audio bytes". Pure `fetch`, zero native.
 *
 * Two use modes:
 * - **固定音色（preset）**：用厂商预置音色合成（gsv2p / minimax / mimo / doubao /
 *   openai-compatible …）。
 * - **语音克隆（clone）**：把一段参考音频 + 它的文本喂给支持复刻的厂商
 *   （cosyvoice 的 3s 极速复刻 / gpt-sovits），bot 就用 TA 的声音说话。每次合成
 *   只带一条参考（cosyvoice 一条；gpt-sovits 可再带几条 aux 做音色平均）。
 *
 * 返回解码分五类（照插件）：原始二进制 / base64 / hex / 流式(豆包) / Gradio 文件。
 * 配置结构（{@link TtsProviderConfig}）由全局 AppSettings 持有（user_config.ts）。
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** 支持的 TTS 厂商（照 MaiBot 插件 + 一个通用 OpenAI 兼容）。 */
export type TtsVendor =
  | 'openai-compatible'
  | 'gsv2p'
  | 'minimax'
  | 'mimo'
  | 'doubao'
  | 'gpt-sovits'
  | 'cosyvoice';

/** 一个 TTS 服务商配置（存在全局 AppSettings.voiceTranscribe.ttsProviders）。 */
export interface TtsProviderConfig {
  id: string;
  /** 用户可改的显示名。 */
  name: string;
  vendor: TtsVendor;
  /** API 地址 / 本地服务地址 / Gradio 地址。 */
  baseUrl: string;
  /** Bearer token / api-key / 豆包 access key（按厂商语义）。 */
  apiKey: string;
  /** 豆包 X-Api-App-Id。 */
  appId?: string;
  /** 豆包 X-Api-Resource-Id。 */
  resourceId?: string;
  /** TTS 模型 id（固定音色 / preset 模式；厂商相关，可空用默认）。 */
  model?: string;
  /** 语音复刻模型 id（clone 模式；部分厂商 preset 与 clone 是不同模型，如 mimo）。可空用默认。 */
  cloneModel?: string;
  /** 默认音色 / voice_id（preset 模式用）。 */
  voice?: string;
  /** 音频格式 mp3 | wav。 */
  format?: string;
  /** 语速（厂商语义不同，1.0 为常态）。 */
  speed?: number;
  createdAt: number;
  updatedAt: number;
}

/** 参考音频 = 本地 wav 路径 + 它的文本（复刻需要 prompt_text）。 */
export interface TtsRefClip {
  path: string;
  text: string;
}

export interface TtsSynthesizeOptions {
  /** 覆盖默认音色（preset 模式）。 */
  voice?: string;
  /** 情感关键词（部分厂商支持，映射成各自参数）。 */
  emotion?: string;
  /** 复刻模式的主参考音频（cosyvoice/gpt-sovits）。 */
  refClip?: TtsRefClip;
  /** gpt-sovits 的附加参考（音色平均，可空）。 */
  auxRefClips?: TtsRefClip[];
  /** 覆盖输出格式。 */
  format?: string;
  /** 超时（ms），默认 60s。 */
  timeoutMs?: number;
}

export interface TtsSynthesizeResult {
  audio: Buffer;
  /** 实际音频格式（mp3 | wav），供前端容器/扩展名用。 */
  format: string;
}

/** 厂商能力：能否固定音色 / 能否复刻（带参考音频）。 */
export interface TtsCapabilities {
  fixedVoice: boolean;
  clone: boolean;
}

/** 厂商模板（设置页新建 provider 一键带入 + 前端表单字段提示）。 */
export interface TtsVendorCatalogEntry {
  vendor: TtsVendor;
  label: string;
  /** 默认 baseUrl。 */
  baseUrl: string;
  apiKeyHint?: string;
  capabilities: TtsCapabilities;
  /** 该厂商配置用到哪些字段（前端据此显隐表单项）。 */
  fields: Array<'apiKey' | 'appId' | 'resourceId' | 'model' | 'cloneModel' | 'voice' | 'format' | 'speed'>;
  /** 默认模型（preset 模式 / model 留空时用；前端表单展示成占位与提示）。 */
  defaultModel?: string;
  /** 语音复刻默认模型（clone 模式 / model 留空时用；前端把它作为「语音克隆默认配置」显示出来）。 */
  cloneModel?: string;
  /** 预置音色（preset 模式下拉）。 */
  presetVoices?: Array<{ id: string; label: string }>;
  /** 重点推荐（UI 高亮）。 */
  recommended?: boolean;
  /** 一句话说明（本地服务 / 公共空间等注意事项）。 */
  note?: string;
}

const DEFAULT_TIMEOUT = 60_000;

// ── 厂商模板 ────────────────────────────────────────────────────────────────

export const TTS_VENDOR_CATALOG: TtsVendorCatalogEntry[] = [
  {
    vendor: 'cosyvoice',
    label: 'CosyVoice（ModelScope 公共空间，免费）',
    baseUrl: 'https://funaudiollm-fun-cosyvoice3-0-5b.ms.show/',
    capabilities: { fixedVoice: false, clone: true },
    fields: ['format'],
    recommended: true,
    note: '阿里 CosyVoice3 的 ModelScope Gradio 空间，3 秒极速复刻：无需 key、无需本地服务，直接用 TA 的声音。公共空间偶有排队/限流。',
  },
  {
    vendor: 'gpt-sovits',
    label: 'GPT-SoVITS（本地服务）',
    baseUrl: 'http://127.0.0.1:9880',
    capabilities: { fixedVoice: false, clone: true },
    fields: ['format'],
    note: '需在本机自行运行 GPT-SoVITS API 服务（端口 9880）。参考音频会作为本地路径传给该服务。',
  },
  {
    vendor: 'gsv2p',
    label: 'GSV2P（云端，原神等预置音色）',
    baseUrl: 'https://gsv2p.acgnai.top/v1/audio/speech',
    apiKeyHint: 'API Token（Bearer）',
    capabilities: { fixedVoice: true, clone: false },
    fields: ['apiKey', 'model', 'voice', 'format', 'speed'],
    defaultModel: 'tts-v4',
    presetVoices: [{ id: '原神-中文-派蒙_ZH', label: '原神·派蒙' }],
  },
  {
    vendor: 'minimax',
    label: 'MiniMax（T2A v2，情感丰富）',
    baseUrl: 'https://api.minimaxi.com/v1/t2a_v2',
    apiKeyHint: 'API Key（Bearer）',
    capabilities: { fixedVoice: true, clone: false },
    fields: ['apiKey', 'model', 'voice', 'format', 'speed'],
    defaultModel: 'speech-2.6-hd',
    presetVoices: [
      { id: 'male-qn-qingse', label: '青涩男声' },
      { id: 'female-shaonv', label: '少女音' },
      { id: 'female-tianmei', label: '甜美女声' },
    ],
  },
  {
    vendor: 'mimo',
    label: '小米 MiMo（OpenAI chat 风格，可复刻）',
    baseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    apiKeyHint: 'api-key',
    capabilities: { fixedVoice: true, clone: true },
    fields: ['apiKey', 'model', 'cloneModel', 'voice', 'format'],
    defaultModel: 'mimo-v2.5-tts',
    cloneModel: 'mimo-v2.5-tts-voiceclone',
    presetVoices: [{ id: 'mimo_default', label: '默认' }],
    note: 'preset 与复刻是不同模型：固定音色用「模型」，语音复刻用「复刻模型」；两者留空各自用默认（mimo-v2.5-tts / mimo-v2.5-tts-voiceclone），参考音频随请求上传。',
  },
  {
    vendor: 'doubao',
    label: '豆包（字节火山引擎）',
    apiKeyHint: 'Access Key（X-Api-Access-Key）',
    baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    capabilities: { fixedVoice: true, clone: false },
    fields: ['apiKey', 'appId', 'resourceId', 'model', 'voice', 'format', 'speed'],
    presetVoices: [{ id: 'zh_female_shuangkuaisisi_moon_bigtts', label: '爽快思思' }],
  },
  {
    vendor: 'openai-compatible',
    label: '通用 OpenAI 兼容（/audio/speech）',
    baseUrl: 'https://api.siliconflow.cn/v1/audio/speech',
    apiKeyHint: 'API Key（Bearer）',
    capabilities: { fixedVoice: true, clone: false },
    fields: ['apiKey', 'model', 'voice', 'format', 'speed'],
    defaultModel: 'FunAudioLLM/CosyVoice2-0.5B',
    note: '硅基流动 / OpenAI 等 /audio/speech 接口。voice 填厂商音色 id（如 FunAudioLLM/CosyVoice2-0.5B:alex）。',
  },
];

export function getTtsCatalogEntry(vendor: TtsVendor): TtsVendorCatalogEntry | undefined {
  return TTS_VENDOR_CATALOG.find((e) => e.vendor === vendor);
}

export function getTtsCapabilities(vendor: TtsVendor): TtsCapabilities {
  return getTtsCatalogEntry(vendor)?.capabilities ?? { fixedVoice: true, clone: false };
}

// ── 情感映射（照插件，按厂商语义不同）──────────────────────────────────────────

const MINIMAX_EMOTION_MAP: Record<string, string> = {
  开心: 'happy', 高兴: 'happy', 兴奋: 'happy',
  伤心: 'sad', 难过: 'sad', 失望: 'sad', 委屈: 'sad',
  生气: 'angry', 愤怒: 'angry',
  害怕: 'fearful', 恐惧: 'fearful', 厌恶: 'disgusted', 恶心: 'disgusted',
  惊讶: 'surprised', 震惊: 'surprised',
  平静: 'calm', 冷静: 'calm', 严肃: 'calm',
  流畅: 'fluent', 自然: 'fluent',
  耳语: 'whisper', 低语: 'whisper', 轻声: 'whisper', 悄悄话: 'whisper',
};
const MINIMAX_VALID_EMOTIONS = new Set(Object.values(MINIMAX_EMOTION_MAP));

const DOUBAO_EMOTION_MAP: Record<string, string> = {
  开心: '你的语气再欢乐一点', 兴奋: '用特别兴奋激动的语气说话', 温柔: '用温柔体贴的语气说话',
  生气: '你得跟我互怼！就是跟我用吵架的语气对话', 愤怒: '用愤怒的语气说话', 伤心: '用特别特别痛心的语气说话',
  失望: '用失望沮丧的语气说话', 委屈: '用委屈的语气说话', 平静: '用平静淡定的语气说话',
  严肃: '用严肃认真的语气说话', 慢速: '说慢一点', 快速: '说快一点', 小声: '你嗓门再小点', 大声: '大声一点',
};

// ── 工具 ────────────────────────────────────────────────────────────────────

/** 检测主语言（zh/ja/en），照插件 detect_language。 */
function detectLanguage(text: string): 'zh' | 'ja' | 'en' {
  if (!text) return 'zh';
  const zh = (text.match(/[一-鿿]/g) ?? []).length;
  const en = (text.match(/[a-zA-Z]/g) ?? []).length;
  const ja = (text.match(/[぀-ゟ゠-ヿ]/g) ?? []).length;
  const total = zh + en + ja;
  if (total === 0) return 'zh';
  if (zh / total > 0.3) return 'zh';
  if (ja / total > 0.3) return 'ja';
  if (en / total > 0.8) return 'en';
  return 'zh';
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** 至少 100 字节才算有效音频（照插件 validate_audio_data）。 */
function ensureAudio(buf: Buffer, vendor: string): Buffer {
  if (!buf || buf.length < 100) throw new Error(`${vendor} 返回的音频数据无效（${buf?.length ?? 0} 字节）`);
  return buf;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── 各厂商后端：text → 音频字节 ──────────────────────────────────────────────

type Backend = (cfg: TtsProviderConfig, text: string, opts: TtsSynthesizeOptions) => Promise<TtsSynthesizeResult>;

/** OpenAI 兼容 /audio/speech（SiliconFlow / OpenAI / 自建），返回原始二进制。 */
const openAiCompatible: Backend = async (cfg, text, opts) => {
  const format = opts.format ?? cfg.format ?? 'mp3';
  const res = await fetchWithTimeout(
    cfg.baseUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model || 'FunAudioLLM/CosyVoice2-0.5B',
        input: text,
        voice: opts.voice ?? cfg.voice ?? '',
        response_format: format,
        speed: cfg.speed ?? 1,
      }),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT,
  );
  if (!res.ok) throw new Error(`TTS(openai) HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return { audio: ensureAudio(Buffer.from(await res.arrayBuffer()), 'openai'), format };
};

/** GSV2P：与 /audio/speech 同形状，带 5 次重试。 */
const gsv2p: Backend = async (cfg, text, opts) => {
  const format = opts.format ?? cfg.format ?? 'mp3';
  let lastErr = '';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const res = await fetchWithTimeout(
        cfg.baseUrl || 'https://gsv2p.acgnai.top/v1/audio/speech',
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model || 'tts-v4',
            input: text,
            voice: opts.voice ?? cfg.voice ?? '原神-中文-派蒙_ZH',
            response_format: format,
            speed: cfg.speed ?? 1,
          }),
        },
        opts.timeoutMs ?? DEFAULT_TIMEOUT,
      );
      const ct = res.headers.get('content-type') ?? '';
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok && !ct.includes('application/json')) return { audio: ensureAudio(buf, 'gsv2p'), format };
      lastErr = `HTTP ${res.status} — ${buf.toString('utf-8').slice(0, 150)}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`TTS(gsv2p) 失败（已重试 5 次）：${lastErr}`);
};

/** MiniMax T2A v2：返回 JSON，data.audio 为 hex。 */
const minimax: Backend = async (cfg, text, opts) => {
  const format = opts.format ?? cfg.format ?? 'mp3';
  const emotion = opts.emotion
    ? MINIMAX_EMOTION_MAP[opts.emotion] ?? (MINIMAX_VALID_EMOTIONS.has(opts.emotion) ? opts.emotion : undefined)
    : undefined;
  const voiceSetting: Record<string, unknown> = {
    voice_id: opts.voice ?? cfg.voice ?? 'male-qn-qingse',
    speed: cfg.speed ?? 1.0,
    vol: 1.0,
    pitch: 0,
  };
  if (emotion) voiceSetting.emotion = emotion;
  const res = await fetchWithTimeout(
    cfg.baseUrl || 'https://api.minimaxi.com/v1/t2a_v2',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model || 'speech-2.6-hd',
        text,
        stream: false,
        voice_setting: voiceSetting,
        audio_setting: { sample_rate: 32000, bitrate: 128000, format, channel: 1 },
        output_format: 'hex',
      }),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT,
  );
  if (!res.ok) throw new Error(`TTS(minimax) HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = (await res.json()) as { base_resp?: { status_code?: number; status_msg?: string }; data?: { audio?: string } };
  const code = data.base_resp?.status_code ?? -1;
  if (code !== 0) throw new Error(`TTS(minimax) 业务错误 ${code}：${data.base_resp?.status_msg ?? ''}`);
  const hex = data.data?.audio;
  if (!hex) throw new Error('TTS(minimax) 响应缺少音频');
  return { audio: ensureAudio(Buffer.from(hex, 'hex'), 'minimax'), format };
};

/** 小米 MiMo 默认模型：固定音色 / 语音复刻各一个（model 留空时按模式自动选）。 */
const MIMO_MODEL_PRESET = 'mimo-v2.5-tts';
const MIMO_MODEL_CLONE = 'mimo-v2.5-tts-voiceclone';

/**
 * 小米 MiMo：OpenAI chat 风格，choices[0].message.audio.data 为 base64。
 * - 固定音色（无参考音频）：用 MIMO_MODEL_PRESET + audio.voice。
 * - 语音复刻（带 opts.refClip）：用 MIMO_MODEL_CLONE，把 TA 的参考音频按 OpenAI chat 的
 *   input_audio 形式附在 user 消息里（音色由参考音频决定，voice 可空）。
 * model 显式填了就以填的为准。
 */
const mimo: Backend = async (cfg, text, opts) => {
  const format = opts.format ?? cfg.format ?? 'wav';
  const content = opts.emotion ? `<style>${opts.emotion}</style>${text}` : text;
  const clone = !!opts.refClip;
  // preset 与复刻是不同模型，各自独立配置（留空各用默认）。
  const model = clone
    ? cfg.cloneModel?.trim() || MIMO_MODEL_CLONE
    : cfg.model?.trim() || MIMO_MODEL_PRESET;

  const messages: Array<Record<string, unknown>> = [];
  if (clone && opts.refClip) {
    const refB64 = (await readFile(opts.refClip.path)).toString('base64');
    messages.push({
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: refB64, format: 'wav' } },
        ...(opts.refClip.text ? [{ type: 'text', text: opts.refClip.text }] : []),
      ],
    });
  }
  messages.push({ role: 'assistant', content });

  const audio: Record<string, unknown> = { format };
  const voice = opts.voice ?? cfg.voice;
  if (voice) audio.voice = voice; // 复刻模式音色由参考音频决定，voice 可空
  else if (!clone) audio.voice = 'mimo_default';

  const res = await fetchWithTimeout(
    cfg.baseUrl || 'https://api.xiaomimimo.com/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': cfg.apiKey },
      body: JSON.stringify({ model, messages, audio }),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT,
  );
  if (!res.ok) throw new Error(`TTS(mimo) HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { audio?: { data?: string } } }> };
  const b64 = data.choices?.[0]?.message?.audio?.data;
  if (!b64) throw new Error('TTS(mimo) 响应缺少音频');
  return { audio: ensureAudio(Buffer.from(b64, 'base64'), 'mimo'), format };
};

/** 豆包：换行分隔的 JSON 流，code=0 帧带 base64 音频，code=20000000 结束。 */
const doubao: Backend = async (cfg, text, opts) => {
  const format = opts.format ?? cfg.format ?? 'mp3';
  const emotion = opts.emotion ? DOUBAO_EMOTION_MAP[opts.emotion] : undefined;
  const reqParams: Record<string, unknown> = {
    text,
    speaker: opts.voice ?? cfg.voice ?? 'zh_female_shuangkuaisisi_moon_bigtts',
    audio_params: { format, sample_rate: 24000, bitrate: 128000 },
  };
  if (cfg.speed) reqParams.speed = cfg.speed;
  if (emotion) reqParams.context_texts = [emotion];
  const res = await fetchWithTimeout(
    cfg.baseUrl || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Api-App-Id': cfg.appId ?? '',
        'X-Api-Access-Key': cfg.apiKey,
        'X-Api-Resource-Id': cfg.resourceId ?? 'seed-tts-2.0',
        'X-Api-Request-Id': cryptoRandomId(),
      },
      body: JSON.stringify({ req_params: reqParams }),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT,
  );
  if (!res.ok) throw new Error(`TTS(doubao) HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 150)}`);
  const body = await res.text();
  const chunks: Buffer[] = [];
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj: { code?: number; data?: string; message?: string };
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    const code = obj.code ?? -1;
    if (code === 0) {
      if (obj.data) chunks.push(Buffer.from(obj.data, 'base64'));
    } else if (code === 20000000) {
      break;
    } else if (code > 0) {
      throw new Error(`TTS(doubao) API 错误 ${code}：${obj.message ?? ''}`);
    }
  }
  if (chunks.length === 0) throw new Error('TTS(doubao) 未返回音频');
  return { audio: ensureAudio(mergeDoubaoChunks(chunks), 'doubao'), format };
};

/** GPT-SoVITS 本地服务：POST /tts，参考音频为本地路径，返回 wav 二进制。 */
const gptSovits: Backend = async (cfg, text, opts) => {
  const ref = opts.refClip;
  if (!ref) throw new Error('GPT-SoVITS 需要参考音频');
  const server = trimSlash(cfg.baseUrl || 'http://127.0.0.1:9880');
  const body: Record<string, unknown> = {
    text,
    text_lang: detectLanguage(text),
    ref_audio_path: ref.path,
    prompt_text: ref.text,
    prompt_lang: detectLanguage(ref.text),
  };
  const aux = (opts.auxRefClips ?? []).map((c) => c.path).filter(Boolean);
  if (aux.length > 0) body.aux_ref_audio_paths = aux;
  const res = await fetchWithTimeout(
    `${server}/tts`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    opts.timeoutMs ?? DEFAULT_TIMEOUT,
  );
  if (!res.ok) throw new Error(`TTS(gpt-sovits) HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 150)}`);
  return { audio: ensureAudio(Buffer.from(await res.arrayBuffer()), 'gpt-sovits'), format: 'wav' };
};

/** CosyVoice：ModelScope Gradio 空间，3s 极速复刻（上传参考音频 → /call → 取结果文件）。 */
const cosyvoice: Backend = async (cfg, text, opts) => {
  const ref = opts.refClip;
  if (!ref) throw new Error('CosyVoice 需要参考音频');
  const root = trimSlash(cfg.baseUrl || 'https://funaudiollm-fun-cosyvoice3-0-5b.ms.show');
  const timeout = opts.timeoutMs ?? Math.max(DEFAULT_TIMEOUT, 180_000);

  // 1) 上传参考音频到 Gradio，拿到服务端文件引用。
  const wav = await readFile(ref.path);
  const form = new FormData();
  form.append('files', new Blob([wav], { type: 'audio/wav' }), basename(ref.path));
  const up = await fetchWithTimeout(`${root}/upload`, { method: 'POST', body: form }, timeout);
  if (!up.ok) throw new Error(`CosyVoice 上传参考音频失败 HTTP ${up.status}`);
  const uploaded = (await up.json()) as string[];
  const serverPath = uploaded?.[0];
  if (!serverPath) throw new Error('CosyVoice 上传参考音频未返回路径');

  // 2) 触发 /call/generate_audio（参数顺序照插件 client.predict）。
  const payload = {
    data: [
      text, // tts_text
      '3s极速复刻', // mode_checkbox_group
      ref.text, // prompt_text
      { path: serverPath, meta: { _type: 'gradio.FileData' } }, // prompt_wav_upload
      null, // prompt_wav_record
      'You are a helpful assistant.<|endofprompt|>', // instruct_text
      0, // seed
      false, // stream
    ],
  };
  const call = await fetchWithTimeout(
    `${root}/call/generate_audio`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    timeout,
  );
  if (!call.ok) throw new Error(`CosyVoice 调用失败 HTTP ${call.status}`);
  const callJson = (await call.json()) as { event_id?: string };
  const eventId = callJson.event_id;
  if (!eventId) throw new Error('CosyVoice 未返回 event_id');

  // 3) SSE 拉结果：事件流里找到带文件 url 的完成帧。
  const result = await fetchWithTimeout(`${root}/call/generate_audio/${eventId}`, { method: 'GET' }, timeout);
  if (!result.ok) throw new Error(`CosyVoice 取结果失败 HTTP ${result.status}`);
  const stream = await result.text();
  const fileUrl = extractGradioFileUrl(stream, root);
  if (!fileUrl) throw new Error('CosyVoice 结果里找不到音频文件');

  // 4) 下载生成的音频。
  const audioRes = await fetchWithTimeout(fileUrl, { method: 'GET' }, timeout);
  if (!audioRes.ok) throw new Error(`CosyVoice 下载音频失败 HTTP ${audioRes.status}`);
  return { audio: ensureAudio(Buffer.from(await audioRes.arrayBuffer()), 'cosyvoice'), format: 'wav' };
};

const BACKENDS: Record<TtsVendor, Backend> = {
  'openai-compatible': openAiCompatible,
  gsv2p,
  minimax,
  mimo,
  doubao,
  'gpt-sovits': gptSovits,
  cosyvoice,
};

// ── 解析 Gradio SSE 结果里的文件 url ─────────────────────────────────────────

function extractGradioFileUrl(sse: string, root: string): string | null {
  // SSE 形如：event: complete\n data: [{"path":"...","url":"https://.../file=..."}]
  for (const line of sse.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const json = s.slice(5).trim();
    if (!json || json === 'null') continue;
    try {
      const parsed = JSON.parse(json);
      const url = findFileUrl(parsed, root);
      if (url) return url;
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return null;
}

function findFileUrl(node: unknown, root: string): string | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const url = findFileUrl(item, root);
      if (url) return url;
    }
    return null;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.url === 'string' && obj.url) return obj.url;
    if (typeof obj.path === 'string' && obj.path) return `${root}/file=${obj.path}`;
    for (const v of Object.values(obj)) {
      const url = findFileUrl(v, root);
      if (url) return url;
    }
  }
  return null;
}

// ── 豆包流式 WAV 合并（照插件 _merge_audio_chunks 简化版）────────────────────

function mergeDoubaoChunks(chunks: Buffer[]): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  const first = chunks[0]!;
  // 非 WAV（如 mp3）直接拼接。
  if (first.length < 44 || first.toString('ascii', 0, 4) !== 'RIFF') return Buffer.concat(chunks);
  const dataOffset = findWavDataOffset(first);
  const header = Buffer.from(first.subarray(0, dataOffset));
  const parts: Buffer[] = [first.subarray(dataOffset)];
  for (const c of chunks.slice(1)) {
    if (c.length > 44 && c.toString('ascii', 0, 4) === 'RIFF') parts.push(c.subarray(findWavDataOffset(c)));
    else parts.push(c);
  }
  const audio = Buffer.concat(parts);
  header.writeUInt32LE(header.length - 8 + audio.length, 4);
  header.writeUInt32LE(audio.length, dataOffset - 4);
  return Buffer.concat([header, audio]);
}

function findWavDataOffset(header: Buffer): number {
  let pos = 12;
  while (pos < header.length - 8) {
    const id = header.toString('ascii', pos, pos + 4);
    const size = header.readUInt32LE(pos + 4);
    if (id === 'data') return pos + 8;
    pos += 8 + size + (size % 2 === 1 ? 1 : 0);
  }
  return 44;
}

function cryptoRandomId(): string {
  // 不依赖 randomUUID 的轻量请求 id（豆包只要唯一即可）。
  return `weq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── 服务门面 ────────────────────────────────────────────────────────────────

export class TtsService {
  listCatalog(): TtsVendorCatalogEntry[] {
    return TTS_VENDOR_CATALOG;
  }

  capabilities(vendor: TtsVendor): TtsCapabilities {
    return getTtsCapabilities(vendor);
  }

  /** 合成一段语音，返回音频字节 + 格式。失败抛错（调用方决定降级）。 */
  async synthesize(cfg: TtsProviderConfig, text: string, opts: TtsSynthesizeOptions = {}): Promise<TtsSynthesizeResult> {
    const body = text.trim();
    if (!body) throw new Error('待合成文本为空');
    const backend = BACKENDS[cfg.vendor];
    if (!backend) throw new Error(`未知 TTS 厂商：${cfg.vendor}`);
    return backend(cfg, body, opts);
  }

  /** 设置页「测试」：合成一句样例，返回 base64 供前端试听。 */
  async testProvider(
    cfg: TtsProviderConfig,
    sample = '你好呀，这是一条语音测试。',
  ): Promise<{ ok: boolean; error?: string; audioBase64?: string; format?: string }> {
    try {
      const caps = this.capabilities(cfg.vendor);
      // 复刻型厂商在「测试」时没有参考音频，无法合成 → 只校验可达性给提示。
      if (caps.clone && !caps.fixedVoice) {
        return { ok: true, error: '该厂商为语音克隆型，需在克隆体里绑定参考音频后才能试听。' };
      }
      const { audio, format } = await this.synthesize(cfg, sample, { timeoutMs: 30_000 });
      return { ok: true, audioBase64: audio.toString('base64'), format };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
