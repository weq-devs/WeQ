/** 模型代码默认在 QuickJS/WASM 中解释执行；任意权限必须由宿主显式传入。 */
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { SANDBOX_WORKER_SOURCE } from './sandbox_worker_source';

export const JS_SANDBOX_DEFAULT_TIMEOUT_MS = 15_000;
export const JS_SANDBOX_MAX_TIMEOUT_MS = 45_000;
export const JS_SANDBOX_MAX_ARGUMENT_CHARS = 200_000;
const MAX_CODE_CHARS = 20_000;
const MAX_TOOL_CALLS = 40;
const MAX_CALL_RESULT_CHARS = 200_000;

export type SandboxToolRunner = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface JsSandboxCall {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  /** 超时或停止不等于已发出的宿主操作已回滚。 */
  state?: 'running' | 'completed' | 'unknown';
}

export interface JsSandboxResult {
  ok: boolean;
  result: unknown;
  error?: string;
  logs: string[];
  calls: JsSandboxCall[];
  ms: number;
  truncated?: string;
  notes?: string[];
  unawaited?: number;
}

interface WorkerMessage {
  kind: 'call' | 'done';
  id?: number;
  name?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  resultText?: string;
  error?: string;
  logs?: string[];
  notes?: string[];
  unawaited?: number;
  truncated?: string;
}

export async function runJsSandbox(
  code: string,
  callTool: SandboxToolRunner,
  timeoutMs = JS_SANDBOX_DEFAULT_TIMEOUT_MS,
  options: { permissionMode?: 'sandbox' | 'unrestricted'; signal?: AbortSignal } = {},
): Promise<JsSandboxResult> {
  const startedAt = Date.now();
  const calls: JsSandboxCall[] = [];
  const fail = (error: string): JsSandboxResult => ({
    ok: false,
    result: null,
    error,
    logs: [],
    calls,
    ms: Date.now() - startedAt,
  });
  if (typeof code !== 'string' || !code.trim()) return fail('code 为空');
  if (code.length > MAX_CODE_CHARS) return fail(`code 过长（上限 ${MAX_CODE_CHARS} 字符）`);
  if (options.signal?.aborted) return fail('脚本已取消');
  const limit = Number.isFinite(timeoutMs)
    ? Math.min(Math.max(timeoutMs, 1000), JS_SANDBOX_MAX_TIMEOUT_MS)
    : JS_SANDBOX_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(SANDBOX_WORKER_SOURCE, {
      eval: true,
      workerData: {
        code,
        limit,
        maxToolCalls: MAX_TOOL_CALLS,
        maxArgumentChars: JS_SANDBOX_MAX_ARGUMENT_CHARS,
        // 依赖保持外置，worker 与已打包主进程从同一安装位置解析 WASM。
        quickjsPath: createRequire(import.meta.url).resolve('quickjs-emscripten'),
        unrestricted: options.permissionMode === 'unrestricted',
      },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    });
    const settle = (result: JsSandboxResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      controller.abort();
      void worker.terminate();
      const snapshot = calls.map((call) => ({
        ...call,
        state: call.state === 'running' ? ('unknown' as const) : call.state,
      }));
      const unknown = snapshot.filter((call) => call.state === 'unknown');
      resolve({
        ...result,
        calls: snapshot,
        ...(unknown.length
          ? {
              ok: false,
              notes: [
                ...(result.notes ?? []),
                '存在尚未确认终态的宿主操作，可能仍会完成；不要自动重试，请先核对实际结果。',
              ],
            }
          : {}),
      });
    };
    const onAbort = (): void => settle(fail('脚本已取消；已发出的操作不保证回滚'));
    const timer = setTimeout(
      () => settle(fail(`脚本执行超过 ${limit}ms 已中止；已发出的操作不保证回滚`)),
      limit,
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const handleCall = async (msg: WorkerMessage): Promise<void> => {
      if (settled) return;
      const name = String(msg.name);
      const reply = (ok: boolean, text: string): void => {
        if (!settled) worker.postMessage({ kind: 'callResult', id: msg.id, ok, text });
      };
      if (calls.length >= MAX_TOOL_CALLS || name === 'run_js') {
        reply(
          false,
          name === 'run_js' ? '禁止递归调用 run_js' : `工具调用超过 ${MAX_TOOL_CALLS} 次上限`,
        );
        return;
      }
      const call: JsSandboxCall = { name, ok: false, ms: 0, state: 'running' };
      calls.push(call);
      const start = Date.now();
      try {
        const value = await callTool(name, msg.args ?? {}, controller.signal);
        let text =
          JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? String(v) : v)) ?? 'null';
        if (text.length > MAX_CALL_RESULT_CHARS)
          text = JSON.stringify({
            __truncated: true,
            preview: text.slice(0, MAX_CALL_RESULT_CHARS),
          });
        call.ok = true;
        reply(true, text);
      } catch (error) {
        call.error = (error instanceof Error ? error.message : String(error)).slice(0, 400);
        reply(false, call.error);
      } finally {
        call.ms = Date.now() - start;
        call.state = 'completed';
      }
    };
    worker.on('message', (msg: WorkerMessage) => {
      if (settled || !msg || typeof msg !== 'object') return;
      if (msg.kind === 'call') {
        void handleCall(msg);
        return;
      }
      if (msg.kind === 'done') {
        let result: unknown = null;
        try {
          result = msg.resultText ? JSON.parse(msg.resultText) : null;
        } catch {
          result = msg.resultText;
        }
        settle({
          ok: msg.ok === true,
          result,
          error: msg.error,
          logs: msg.logs ?? [],
          calls,
          ms: Date.now() - startedAt,
          notes: msg.notes,
          unawaited: msg.unawaited,
          truncated: msg.truncated,
        });
      }
    });
    worker.on('error', (error) => settle(fail(`脚本进程异常：${error.message}`)));
    worker.on('exit', (exitCode) => settle(fail(`脚本进程意外退出（code ${exitCode}）`)));
  });
}
