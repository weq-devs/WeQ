import { open, readFile, rename, stat, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  bounded,
  networkFetch,
  downloadSources,
  resolveDownloadSources,
  recordSourceHealth,
} from '@weq/network';
import { TransferGate, shouldPauseTransfer, LARGE_TRANSFER_BYTES } from './data_saver';
import {
  transferOwner,
  transferRestricted,
  transferCanResume,
  watchTransferPolicy,
} from './transfer_policy';
import { networkScope, transferBehavior } from './network_scope';

const PAUSED = new Error('transfer paused');
export class TransferDeferredError extends Error {
  constructor() {
    super('省流量模式已暂缓自动加载');
  }
}
interface ResumeRecord {
  url: string;
  validator: string;
  total: number;
  sha256?: string;
}
export interface DownloadIdentity {
  sha256: string;
  size: number;
}
class DownloadFailure extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}
export interface DownloadState {
  paused: boolean;
  reasons: string[];
  received: number;
  total: number;
  source?: string;
  attempt?: number;
  retryAt?: number;
}
export const transferActivity = new EventEmitter();
export interface TransferActivity extends DownloadState {
  id: string;
  name: string;
  transfer: ManagedDownload;
  done?: boolean;
  cancelled?: boolean;
  error?: string;
}

/** 一个任务一次放行；中止真实请求，完整检查 Range 后才续写临时文件。 */
export class ManagedDownload {
  private readonly owner = transferOwner();
  private gate = new TransferGate();
  private request?: AbortController;
  private received = 0;
  private total: number;
  private readonly id = globalThis.crypto.randomUUID();
  private lastState = '';
  private activityStarted = false;
  private policyPaused = false;
  private source?: string;
  private attempt = 0;
  private retryAt?: number;
  constructor(
    private readonly options: {
      batch?: boolean;
      total?: number;
      state?: (state: DownloadState) => void;
      name?: string;
      activityPageId?: string;
      /** 没有任务入口的缓存填充不等待手动继续。 */
      deferOnPolicyPause?: boolean;
      signal?: AbortSignal;
      maxBytes?: number;
      timeoutMs?: number;
      idleTimeoutMs?: number;
      maxAttempts?: number;
      attemptsPerSource?: number;
      retryBaseMs?: number;
      identity?: DownloadIdentity;
      fetcher?: typeof fetch;
      validate?: (path: string, response: Response, bytes: number) => Promise<void>;
      publish?: (path: string, target: string) => Promise<void>;
    } = {},
  ) {
    this.total = options.total ?? 0;
    if (networkScope.getStore()?.override) this.gate.continue();
  }
  get activityPageId() {
    return this.options.activityPageId;
  }
  pause() {
    this.gate.pause();
    this.update();
  }
  continue() {
    this.gate.continue();
    this.update();
  }
  private update() {
    const behavior = transferBehavior();
    const complete = this.total > 0 && this.received >= this.total;
    const restricted =
      transferRestricted(this.owner) || (this.policyPaused && !transferCanResume(this.owner));
    this.policyPaused = restricted;
    const policyBlocked =
      !complete &&
      shouldPauseTransfer(
        restricted,
        this.options.batch ?? false,
        this.total,
        this.received,
        behavior,
      );
    if (
      !policyBlocked &&
      this.gate.pauseReasons.includes('network') &&
      !behavior.dataSaverAutoResume
    )
      this.gate.restrict('resume-required', true);
    if (!policyBlocked && behavior.dataSaverAutoResume)
      this.gate.restrict('resume-required', false);
    this.gate.restrict('network', policyBlocked);
    if (this.gate.paused) this.request?.abort(PAUSED);
    const state = {
      paused: this.gate.paused,
      reasons: this.gate.pauseReasons,
      received: this.received,
      total: this.total,
      source: this.source,
      attempt: this.attempt,
      retryAt: this.retryAt,
    };
    const key = JSON.stringify([
      state.paused,
      state.reasons,
      Math.floor(state.received / (256 * 1024)),
      state.total,
      state.source,
      state.attempt,
      state.retryAt,
    ]);
    if (key !== this.lastState) {
      this.lastState = key;
      this.options.state?.(state);
      if (
        this.options.name &&
        (this.activityStarted ||
          state.paused ||
          state.total >= LARGE_TRANSFER_BYTES ||
          state.received >= LARGE_TRANSFER_BYTES)
      ) {
        this.activityStarted = true;
        transferActivity.emit('state', {
          ...state,
          id: this.id,
          name: this.options.name,
          transfer: this,
        } satisfies TransferActivity);
      }
    }
  }
  private waitForFileTransfer(signal?: AbortSignal): Promise<void> {
    if (this.options.deferOnPolicyPause && this.gate.paused) throw new TransferDeferredError();
    return this.gate.wait(signal);
  }
  response(response: Response): Response {
    if (!response.ok || !response.body) return response;
    this.total = Number(response.headers.get('content-length') ?? 0) || 0;
    const reader = response.body.getReader();
    const stopped = new AbortController();
    let ended = false;
    const unwatch = watchTransferPolicy(() => this.update());
    const finish = (error?: unknown) => {
      if (ended) return;
      ended = true;
      unwatch();
      if (this.options.name && this.activityStarted)
        transferActivity.emit('state', {
          id: this.id,
          name: this.options.name,
          transfer: this,
          paused: false,
          reasons: [],
          received: this.received,
          total: this.total,
          ...(error ? { error: String(error) } : { done: true }),
        } satisfies TransferActivity);
    };
    this.update();
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            this.update();
            await this.gate.wait(stopped.signal);
            const item = await reader.read();
            if (item.done) {
              finish();
              controller.close();
              return;
            }
            this.received += item.value.byteLength;
            controller.enqueue(item.value);
          } catch (error) {
            finish(error);
            controller.error(error);
            await reader.cancel().catch(() => undefined);
          }
        },
        cancel: async (reason) => {
          stopped.abort(reason);
          finish(reason ?? new Error('下载已取消'));
          await reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  async file(
    url: string | readonly string[],
    target: string,
    headers: Record<string, string> = {},
    progress?: (received: number, total: number, speed: number) => void,
    identity = this.options.identity,
  ): Promise<void> {
    const part = `${target}.part`;
    const meta = `${target}.resume.json`;
    if (
      identity &&
      (!/^[a-f0-9]{64}$/.test(identity.sha256) ||
        !Number.isSafeInteger(identity.size) ||
        identity.size <= 0)
    )
      throw new Error('下载内容身份无效');
    const sources = [...new Set(typeof url === 'string' ? downloadSources(url) : url)];
    if (!sources.length) throw new Error('没有可用的下载来源');
    let candidates = sources;
    let resolved = !!this.options.fetcher;
    let sourceIndex = 0;
    let sourceAttempts = 0;
    this.attempt = 0;
    this.source = new URL(candidates[0]!).host;
    this.retryAt = undefined;
    let resume: ResumeRecord | undefined;
    try {
      const saved: ResumeRecord = JSON.parse(await readFile(meta, 'utf8'));
      if (
        ((sources.includes(saved.url) && saved.validator) ||
          (identity && saved.sha256 === identity.sha256)) &&
        Number.isSafeInteger(saved.total) &&
        saved.total > 0 &&
        (!identity || saved.total === identity.size)
      ) {
        resume = saved;
        this.received = (await stat(part)).size;
        this.total = saved.total;
        if (this.received > saved.total) resume = undefined;
      }
    } catch {
      /* 首次下载或未完成元数据时从头开始，不拼接未知资源。 */
    }
    if (!resume) this.received = 0;
    const unwatch = watchTransferPolicy(() => this.update());
    const abort = () => this.request?.abort(this.options.signal?.reason);
    this.options.signal?.addEventListener('abort', abort);
    try {
      for (;;) {
        this.options.signal?.throwIfAborted();
        this.update();
        await this.waitForFileTransfer(this.options.signal);
        this.request = new AbortController();
        const request = this.request;
        const signal = this.options.signal
          ? AbortSignal.any([request.signal, this.options.signal])
          : request.signal;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let file: Awaited<ReturnType<typeof open>> | undefined;
        let delay = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const armTimeout = (ms: number) => {
          clearTimeout(timer);
          timer = setTimeout(
            () => request.abort(new DOMException('下载连接或读取超时', 'TimeoutError')),
            ms,
          );
        };
        const startedAt = Date.now();
        try {
          if (!resolved) {
            candidates = await resolveDownloadSources(sources, signal);
            resolved = true;
          }
          const currentUrl = candidates[sourceIndex]!;
          if (identity && resume?.sha256 === identity.sha256 && this.received === identity.size) {
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(part)) {
              signal.throwIfAborted();
              hash.update(chunk);
            }
            if (hash.digest('hex') === identity.sha256) {
              await this.options.validate?.(
                part,
                new Response(null, { headers: { 'Content-Type': 'application/octet-stream' } }),
                this.received,
              );
              signal.throwIfAborted();
              await (this.options.publish ?? rename)(part, target);
              await rm(meta, { force: true });
              progress?.(this.received, identity.size, 0);
              if (this.options.name && this.activityStarted)
                transferActivity.emit('state', {
                  id: this.id,
                  name: this.options.name,
                  transfer: this,
                  paused: false,
                  reasons: [],
                  received: this.received,
                  total: identity.size,
                  done: true,
                } satisfies TransferActivity);
              return;
            }
            await rm(part, { force: true });
            await rm(meta, { force: true });
            resume = undefined;
            this.received = 0;
          }
          this.source = new URL(currentUrl).host;
          this.retryAt = undefined;
          this.attempt++;
          sourceAttempts++;
          this.update();
          const offset = resume ? this.received : 0;
          const sameSource = resume?.url === currentUrl;
          armTimeout(this.options.timeoutMs ?? 15000);
          const fetched = (this.options.fetcher ?? networkFetch)(currentUrl, {
            signal,
            headers: {
              ...headers,
              'Accept-Encoding': 'identity',
              ...(offset && resume
                ? {
                    Range: `bytes=${offset}-`,
                    ...(sameSource && resume.validator ? { 'If-Range': resume.validator } : {}),
                    'Accept-Encoding': 'identity',
                  }
                : {}),
            },
          });
          void fetched.then(
            (response) => {
              if (signal.aborted) void response.body?.cancel().catch(() => {});
            },
            () => {},
          );
          const response = await bounded(fetched, signal);
          clearTimeout(timer);
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            const value = response.headers.get('retry-after');
            const after = value
              ? /^\d+$/.test(value)
                ? Number(value) * 1000
                : Math.max(0, Date.parse(value) - Date.now())
              : 0;
            throw new DownloadFailure(
              `下载失败：HTTP ${response.status}`,
              [408, 425, 429].includes(response.status) ||
                (response.status >= 500 && response.status !== 501),
              Number.isFinite(after) ? after : 0,
            );
          }
          const etag = response.headers.get('etag');
          const validator =
            etag && !etag.startsWith('W/') ? etag : (response.headers.get('last-modified') ?? '');
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            response.headers.get('content-range') ?? '',
          );
          const append =
            offset > 0 &&
            response.status === 206 &&
            range &&
            Number(range[1]) === offset &&
            Number(range[3]) === resume?.total &&
            Number(range[2]) >= offset &&
            Number(range[2]) < Number(range[3]) &&
            ((identity && resume?.sha256 === identity.sha256) ||
              (sameSource && !!validator && validator === resume?.validator));
          if (response.status === 206 && !append) {
            await response.body.cancel();
            if (!offset) throw new DownloadFailure('下载服务器返回了不匹配的分段', false);
            resume = undefined;
            this.received = 0;
            continue;
          }
          if (!append) this.received = 0;
          const length = Number(response.headers.get('content-length') ?? 0);
          this.total = append && range ? Number(range[3]) : Number.isFinite(length) ? length : 0;
          if (identity && this.total && this.total !== identity.size) {
            await response.body.cancel();
            throw new DownloadFailure('下载长度与文件身份不匹配', false);
          }
          if (!this.total && identity) this.total = identity.size;
          if (this.total > (this.options.maxBytes ?? identity?.size ?? Infinity)) {
            await response.body.cancel();
            throw new Error('媒体超过大小上限。');
          }
          resume = { url: currentUrl, validator, total: this.total, sha256: identity?.sha256 };
          this.update();
          if (this.gate.paused) {
            await response.body.cancel();
            continue;
          }
          file = await open(part, append ? 'a' : 'w');
          await writeFile(meta, JSON.stringify(resume));
          reader = response.body.getReader();
          let previous = this.received;
          let at = Date.now();
          let reported = 0;
          for (;;) {
            armTimeout(this.options.idleTimeoutMs ?? 30000);
            let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;
            try {
              chunk = await bounded(reader.read(), signal);
            } catch (error) {
              if (signal.aborted) throw signal.reason;
              throw new DownloadFailure(error instanceof Error ? error.message : '下载连接中断');
            }
            clearTimeout(timer);
            if (chunk.done) break;
            signal.throwIfAborted();
            let written = 0;
            while (written < chunk.value.byteLength) {
              const result = await file.write(
                chunk.value,
                written,
                chunk.value.byteLength - written,
              );
              if (!result.bytesWritten) throw new Error('下载文件写入中断');
              written += result.bytesWritten;
            }
            this.received += chunk.value.byteLength;
            if (this.received > (this.options.maxBytes ?? identity?.size ?? Infinity))
              throw new Error('媒体超过大小上限。');
            const now = Date.now();
            if (!reported || now - reported >= 200) {
              progress?.(
                this.received,
                this.total,
                now > at ? ((this.received - previous) * 1000) / (now - at) : 0,
              );
              reported = now;
            }
            if (now - at >= 1000) {
              previous = this.received;
              at = now;
            }
            this.update();
          }
          if (this.total && this.received !== this.total)
            throw new DownloadFailure('下载内容长度不完整');
          progress?.(this.received, this.total, 0);
          await file.close();
          file = undefined;
          if (identity) {
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(part)) {
              signal.throwIfAborted();
              hash.update(chunk);
            }
            if (this.received !== identity.size || hash.digest('hex') !== identity.sha256) {
              await rm(part, { force: true });
              await rm(meta, { force: true });
              resume = undefined;
              this.received = 0;
              throw new DownloadFailure('下载文件哈希校验失败', false);
            }
          }
          await this.options.validate?.(part, response, this.received);
          signal.throwIfAborted();
          await (this.options.publish ?? rename)(part, target);
          const { unlink } = await import('node:fs/promises');
          await unlink(meta).catch(() => undefined);
          recordSourceHealth(
            currentUrl,
            true,
            this.received / Math.max(1, (Date.now() - startedAt) / 1000),
          );
          if (this.options.name && this.activityStarted)
            transferActivity.emit('state', {
              id: this.id,
              name: this.options.name,
              transfer: this,
              paused: false,
              reasons: [],
              received: this.received,
              total: this.total,
              done: true,
            } satisfies TransferActivity);
          return;
        } catch (error) {
          if (request.signal.reason === PAUSED) {
            if (resolved && sourceAttempts) {
              this.attempt--;
              sourceAttempts--;
            }
          } else {
            this.options.signal?.throwIfAborted();
            const retryable =
              error instanceof DownloadFailure
                ? error.retryable
                : error instanceof TypeError ||
                  (request.signal.reason instanceof DOMException &&
                    request.signal.reason.name === 'TimeoutError');
            if (!retryable && !(error instanceof DownloadFailure)) throw error;
            recordSourceHealth(candidates[sourceIndex]!, false);
            if (this.attempt >= (this.options.maxAttempts ?? 8)) throw error;
            if (!retryable || sourceAttempts >= (this.options.attemptsPerSource ?? 2)) {
              if (sourceIndex + 1 < candidates.length) {
                sourceIndex++;
                sourceAttempts = 0;
              } else if (!retryable) throw error;
            }
            const base = this.options.retryBaseMs ?? 1000;
            delay = Math.max(
              Math.min(15000, base * 2 ** Math.max(0, this.attempt - 1)) *
                (1 + Math.random() * 0.2),
              error instanceof DownloadFailure ? error.retryAfterMs : 0,
            );
            this.retryAt = Date.now() + delay;
            this.update();
          }
        } finally {
          clearTimeout(timer);
          request.abort();
          void reader?.cancel().catch(() => undefined);
          await file?.close();
          this.request = undefined;
        }
        if (delay) {
          await this.waitForFileTransfer(this.options.signal);
          const controller = new AbortController();
          const waitSignal = this.options.signal
            ? AbortSignal.any([controller.signal, this.options.signal])
            : controller.signal;
          let waitTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await bounded(
              new Promise<void>((resolve) => {
                waitTimer = setTimeout(resolve, Math.min(delay, 2_147_483_647));
              }),
              waitSignal,
            );
          } finally {
            clearTimeout(waitTimer);
          }
        }
      }
    } catch (error) {
      if (this.options.name && this.activityStarted)
        transferActivity.emit('state', {
          id: this.id,
          name: this.options.name,
          transfer: this,
          paused: false,
          reasons: [],
          received: this.received,
          total: this.total,
          ...(this.options.signal?.aborted ? { cancelled: true } : { error: String(error) }),
        } satisfies TransferActivity);
      throw error;
    } finally {
      unwatch();
      this.options.signal?.removeEventListener('abort', abort);
    }
  }
}
