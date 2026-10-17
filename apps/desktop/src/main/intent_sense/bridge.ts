/**
 * Intent-sense 本地引擎桥：主进程持有 fork 出来的 Laya worker（worker.ts），
 * 对 service 层实现 {@link IntentLocalEnginePort}。
 *
 * 生命周期：下载完成（model_files.downloadLayaBundle）后调
 * {@link startIntentSenseLocalEngine} 拉起 worker 并等待 ready；worker 意外退出
 * 时清空端口（getStatus 立刻反映 localAvailable=false，下次 start 再拉起）。
 * app_context 构造 IntentSenseService 时用 {@link getIntentSenseLocalEngine} 拿
 * 当前端口 —— 端口是「后到」的（服务构造时通常还没启动），所以用可变的持有者
 * 对象而不是闭包快照。
 */

import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EmotionKind,
  IntentKind,
  IntentLocalAnalyzeOptions,
  IntentLocalEnginePort,
  MbtiDim,
} from '@weq/service';
import { getLogger } from '@weq/service';
import { downloadLayaBundle, isLayaBundleReady, type BundleProgress } from './model_files';

const logger = getLogger().child({ scope: 'intent-sense' });

/** 本地引擎对 app_context 暴露的控制面（electron 侧实现，web 恒为 null）。 */
export interface IntentSenseLocalEngine extends IntentLocalEnginePort {
  /** 模型 bundle 落盘目录（weq 用户数据目录下）。 */
  modelDir(): string;
  isModelDownloaded(): boolean;
  download(options: { mirror: boolean; onProgress?: (p: BundleProgress) => void }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * weq 用户数据根（与 @weq/platform 的 appDataRoot 同款派生，不用
 * `app.getPath('userData')` —— dev 模式下那是 Electron 默认目录，与
 * service 层实际落盘的 weq 目录不是同一个，模型会被找丢）。
 */
function weqAppDataRoot(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA;
    if (!base) throw new Error('%APPDATA% not set — cannot derive weq user data root');
    return join(base, 'weq');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'weq');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.config'), 'weq');
}

/** Laya bundle 的落盘位置。 */
export function layaModelDir(): string {
  return join(weqAppDataRoot(), 'models', 'laya-multilingual');
}

interface WorkerMessage {
  type: 'ready' | 'load-error' | 'result' | 'mbti-result' | 'analyze-error';
  id?: number;
  intent?: string;
  emotion?: string;
  intensity?: number;
  sentiment?: number;
  confidence?: number;
  dims?: Array<{ key: string; leftPct: number }>;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 120_000;
const LOAD_TIMEOUT_MS = 120_000;

class LocalEngineBridge implements IntentLocalEnginePort {
  private worker: ReturnType<typeof fork> | null = null;
  private readyFlag = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  get ready(): boolean {
    return this.readyFlag && this.worker !== null;
  }

  async start(modelDir: string): Promise<void> {
    if (this.ready) return;
    await this.stop();
    const workerPath = this.resolveWorkerPath();
    const worker = fork(workerPath, [], {
      // stderr 转发到主进程日志：worker 崩溃时能看到真实原因（此前 ignore 全盲）。
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    this.worker = worker;
    worker.stderr?.on('data', (chunk: Buffer) => {
      logger.warn('intent-sense worker stderr', {
        event: 'intent-sense-worker-stderr',
        text: String(chunk).slice(0, 2000),
      });
    });
    worker.on('message', (msg: WorkerMessage) => this.onMessage(msg));
    // 启动窗口期内 worker 崩溃：把退出码带进 start 的 reject，别让人干等超时。
    let exited = false;
    worker.on('exit', (code) => {
      exited = true;
      this.worker = null;
      this.readyFlag = false;
      this.failAll(new Error(`意图感知本地引擎已退出 (code ${code ?? '?'})`));
    });
    worker.on('error', (error) => {
      this.readyFlag = false;
      this.failAll(error);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('本地引擎加载超时')), LOAD_TIMEOUT_MS);
      const onFirst = (msg: WorkerMessage): void => {
        worker.removeListener('message', onFirst);
        clearTimeout(timer);
        if (msg?.type === 'ready') {
          this.readyFlag = true;
          resolve();
        } else {
          reject(new Error(msg?.error ?? '本地引擎加载失败'));
        }
      };
      const onEarlyExit = (code: number | null): void => {
        clearTimeout(timer);
        worker.removeListener('message', onFirst);
        reject(new Error(`本地引擎进程启动即退出 (code ${code ?? '?'})，详见主进程日志`));
      };
      if (exited) {
        onEarlyExit(null);
        return;
      }
      worker.once('exit', onEarlyExit);
      worker.on('message', onFirst);
      worker.send({ type: 'load', modelDir });
    });
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.readyFlag = false;
    this.failAll(new Error('本地引擎已停止'));
    if (worker) {
      worker.send({ type: 'close' });
      setTimeout(() => worker.kill(), 3_000).unref?.();
    }
  }

  /** 单条文本（及上下文/语用提示） → 意图/情绪（service 的 analyzeOne 消费）。 */
  async analyze(
    text: string,
    options?: IntentLocalAnalyzeOptions,
  ): Promise<{
    intent: IntentKind;
    emotion: EmotionKind;
    intensity: number;
    sentiment: number;
    confidence: number;
  } | null> {
    if (!this.ready) return null;
    try {
      const msg = (await this.request({
        type: 'analyze',
        text,
        mine: options?.mine,
        context: options?.context,
        pragmaticHint: options?.pragmaticHint ?? null,
      })) as WorkerMessage;
      if (msg?.type !== 'result') return null;
      return {
        intent: normalizeIntent(msg.intent),
        emotion: normalizeEmotion(msg.emotion),
        intensity: Number(msg.intensity ?? 50),
        sentiment: Number(msg.sentiment ?? 0),
        confidence: Number(msg.confidence ?? 0.5),
      };
    } catch {
      return null;
    }
  }

  async inferMbti(samples: string[]): Promise<MbtiDim[] | null> {
    if (!this.ready || samples.length === 0) return null;
    try {
      const msg = (await this.request({ type: 'mbti', samples })) as WorkerMessage;
      if (msg?.type !== 'mbti-result' || !Array.isArray(msg.dims)) return null;
      return msg.dims
        .filter(
          (d): d is { key: MbtiDim['key']; leftPct: number } =>
            (d.key === 'EI' || d.key === 'SN' || d.key === 'TF' || d.key === 'JP') &&
            typeof d.leftPct === 'number',
        )
        .map((d) => ({ key: d.key, leftPct: Math.min(100, Math.max(0, d.leftPct)) }));
    } catch {
      return null;
    }
  }

  private request(payload: Record<string, unknown>): Promise<WorkerMessage> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('本地引擎未启动'));
    const id = this.nextId++;
    return new Promise<WorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('本地引擎请求超时'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      worker.send({ ...payload, id });
    });
  }

  private onMessage(msg: WorkerMessage): void {
    if (msg?.id === undefined) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.type === 'analyze-error') pending.reject(new Error(msg.error ?? 'analyze failed'));
    else pending.resolve(msg);
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resolveWorkerPath(): string {
    // 不用裸 __dirname（Electron 主进程 ESM 下该 banner 依赖 import.meta.dirname，
    // 不可靠 —— captureWorker 的同款函数也是 fileURLToPath 写法）。
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, 'intentSenseWorker.mjs'), join(here, '..', 'intentSenseWorker.mjs')];
    return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  }
}

const INTENT_KEYS: readonly IntentKind[] = [
  'question',
  'request',
  'greeting',
  'share',
  'praise',
  'vent',
  'joke',
  'plan',
  'info',
  'chat',
  'other',
];

const EMOTION_KEYS: readonly EmotionKind[] = [
  'joy',
  'excitement',
  'admiration',
  'neutral',
  'sadness',
  'anger',
  'anxiety',
  'affection',
  'fatigue',
  'curiosity',
];

function normalizeIntent(v: unknown): IntentKind {
  return typeof v === 'string' && (INTENT_KEYS as readonly string[]).includes(v)
    ? (v as IntentKind)
    : 'other';
}

function normalizeEmotion(v: unknown): EmotionKind {
  return typeof v === 'string' && (EMOTION_KEYS as readonly string[]).includes(v)
    ? (v as EmotionKind)
    : 'neutral';
}

// ── 单例门面（electron 入口 index.ts 注入给 app_context；web 永不注入）──

let bridge: LocalEngineBridge | null = null;

function ensureBridge(): LocalEngineBridge {
  if (!bridge) bridge = new LocalEngineBridge();
  return bridge;
}

/**
 * 意图感知本地引擎整体控制面：既实现 service 的 {@link IntentLocalEnginePort}
 * （analyze/inferMbti），也实现模型下载/worker 生命周期控制。只在桌面版
 * electron 入口调用一次并注入 app_context —— 该文件 import 了 electron，
 * 不能进 router / app_context 的（web 共享的）模块图。
 */
export function getIntentSenseLocalEngine(): IntentSenseLocalEngine {
  const impl = ensureBridge();
  return {
    get ready() {
      return impl.ready;
    },
    analyze: (text: string, options?: IntentLocalAnalyzeOptions) => impl.analyze(text, options),
    inferMbti: (samples: string[]) => impl.inferMbti(samples),
    modelDir: () => layaModelDir(),
    isModelDownloaded: () => isLayaBundleReady(layaModelDir()),
    download: (options) =>
      downloadLayaBundle({
        destDir: layaModelDir(),
        mirror: options.mirror,
        onProgress: options.onProgress,
      }),
    start: async () => {
      const dir = layaModelDir();
      if (!isLayaBundleReady(dir)) {
        throw new Error('本地模型尚未下载完整');
      }
      await impl.start(dir);
    },
    stop: () => impl.stop(),
  };
}
