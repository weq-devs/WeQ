import { open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { TransferGate, shouldPauseTransfer, LARGE_TRANSFER_BYTES } from './data_saver';
import {
  transferOwner,
  transferRestricted,
  transferCanResume,
  watchTransferPolicy,
} from './transfer_policy';
import { networkScope, transferBehavior } from './network_scope';

const PAUSED = new Error('transfer paused');
interface ResumeRecord {
  url: string;
  validator: string;
  total: number;
}
export interface DownloadState {
  paused: boolean;
  reasons: string[];
  received: number;
  total: number;
}
export const transferActivity = new EventEmitter();
export interface TransferActivity extends DownloadState {
  id: string;
  name: string;
  transfer: ManagedDownload;
  done?: boolean;
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
  constructor(
    private readonly options: {
      batch?: boolean;
      total?: number;
      state?: (state: DownloadState) => void;
      name?: string;
      signal?: AbortSignal;
      maxBytes?: number;
      timeoutMs?: number;
      fetcher?: typeof fetch;
      validate?: (path: string, response: Response, bytes: number) => Promise<void>;
      publish?: (path: string, target: string) => Promise<void>;
    } = {},
  ) {
    this.total = options.total ?? 0;
    if (networkScope.getStore()?.override) this.gate.continue();
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
    };
    const key = JSON.stringify([
      state.paused,
      state.reasons,
      Math.floor(state.received / (256 * 1024)),
      state.total,
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
    url: string,
    target: string,
    headers: Record<string, string> = {},
    progress?: (received: number, total: number, speed: number) => void,
  ): Promise<void> {
    const part = `${target}.part`;
    const meta = `${target}.resume.json`;
    let resume: ResumeRecord | undefined;
    try {
      const saved: ResumeRecord = JSON.parse(await readFile(meta, 'utf8'));
      if (saved.url === url && saved.validator && Number.isFinite(saved.total)) {
        resume = saved;
        this.received = (await stat(part)).size;
        this.total = saved.total;
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
        await this.gate.wait(this.options.signal);
        this.request = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let file: Awaited<ReturnType<typeof open>> | undefined;
        try {
          const offset = resume ? this.received : 0;
          const response = await (this.options.fetcher ?? fetch)(url, {
            signal: AbortSignal.any([
              this.request.signal,
              AbortSignal.timeout(this.options.timeoutMs ?? 60000),
            ]),
            headers: {
              ...headers,
              'Accept-Encoding': 'identity',
              ...(offset && resume
                ? {
                    Range: `bytes=${offset}-`,
                    'If-Range': resume.validator,
                    'Accept-Encoding': 'identity',
                  }
                : {}),
            },
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error(`下载失败：HTTP ${response.status}`);
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
            validator === resume?.validator;
          if (response.status === 206 && !append) {
            await response.body.cancel();
            if (!offset) throw new Error('下载服务器返回了不匹配的分段');
            resume = undefined;
            this.received = 0;
            continue;
          }
          if (!append) this.received = 0;
          const length = Number(response.headers.get('content-length') ?? 0);
          this.total = append && range ? Number(range[3]) : Number.isFinite(length) ? length : 0;
          if (this.total > (this.options.maxBytes ?? Infinity)) {
            await response.body.cancel();
            throw new Error('媒体超过大小上限。');
          }
          resume = { url, validator, total: this.total };
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
            const chunk = await reader.read();
            if (chunk.done) break;
            if (this.request.signal.aborted) throw PAUSED;
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
            if (this.received > (this.options.maxBytes ?? Infinity))
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
          if (this.total && this.received !== this.total) throw new Error('下载内容长度不完整');
          progress?.(this.received, this.total, 0);
          await file.close();
          file = undefined;
          await this.options.validate?.(part, response, this.received);
          await (this.options.publish ?? rename)(part, target);
          const { unlink } = await import('node:fs/promises');
          await unlink(meta).catch(() => undefined);
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
          if (this.request.signal.reason !== PAUSED) throw error;
        } finally {
          await reader?.cancel().catch(() => undefined);
          await file?.close();
          this.request = undefined;
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
          error: String(error),
        } satisfies TransferActivity);
      throw error;
    } finally {
      unwatch();
      this.options.signal?.removeEventListener('abort', abort);
    }
  }
}
