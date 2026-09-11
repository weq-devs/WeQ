/**
 * 助手专用 JS 沙箱。
 *
 * 为什么需要它：`AI_TOOLS` 里的工具都是「一次调用、一个结果」的原子能力，
 * 遇到**批量 / 聚合 / 跨工具**的活（「把上百个群逐个核对一遍」「按角色筛人」
 * 「把几份结果 join 起来统计」），模型只能一个个工具硬调，既慢又容易在参数上
 * 反复试错、还受「一轮最多 24 步」限制。给它一块能写代码的地方，这些活一段
 * 脚本就干完了——而且脚本能自己看到中间数据，不必把每一步都塞回上下文。
 *
 * 设计要点：
 *
 *   - **唯一出口是 `callTool`。** 沙箱里没有 `require` / `import` / `fs` /
 *     `fetch` / `process`，也没有 Node 的任何全局对象；要拿数据只能回调进
 *     `callTool(name, args)`，落到与助手完全相同的工具执行路径上。于是**能力的
 *     边界和审计点都只有一处**：沙箱能做的事 = 助手本来就能做的事，不会凭空多出
 *     网络、文件系统之类的口子。
 *   - **跑在 worker_threads 里，而不是主进程的 vm。** 模型写的代码里一个
 *     `while (true)` 就能冻住整个 Electron 主进程；`node:vm` 的 `timeout` 只
 *     管得住同步段，`await` 之后的段落它管不着。放进 worker 后，超时可以直接
 *     `terminate()` 硬杀，最坏也只是这段脚本失败，应用照常。
 *   - **vm 只是护栏，不是安全边界。** Node 的 `vm` 不承诺隔离恶意代码；这里的
 *     定位是「防手滑、防死循环、防污染宿主全局」，配合 `codeGeneration.strings
 *     = false` 关掉 `eval` / `Function` 这条常见逃逸链。真正跑进来的代码是本机
 *     模型生成的、用户自己的账号数据——不是不可信输入。
 *   - **Worker 源码用字符串 + `eval: true`。** 与 `@weq/service` 的
 *     `db_decrypt.ts` 同款：主进程是 electron-vite 打包产物，独立 worker 文件要
 *     额外配构建才能进包，字符串 worker 最省事也最不容易断。
 */

import { Worker } from 'node:worker_threads';

/** 代码正文长度上限（防止一整坨贴进来）。 */
const MAX_CODE_CHARS = 20_000;

/** 默认执行时限。 */
export const JS_SANDBOX_DEFAULT_TIMEOUT_MS = 15_000;
/**
 * 执行时限上限。**必须明显小于助手侧的单工具超时**（`assistant.ts` 的
 * `TOOL_TIMEOUT_MS` = 60s）：外层先超时的话，这个 worker 就成了没人回收的孤儿。
 */
export const JS_SANDBOX_MAX_TIMEOUT_MS = 45_000;

/** 单个脚本最多调用多少次工具。 */
const MAX_TOOL_CALLS = 40;
/** `console` 收集上限。 */
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 20_000;
/** 单次工具结果允许回灌进沙箱的字符上限。 */
const MAX_CALL_RESULT_CHARS = 200_000;
/** 单个失败调用的原因长度上限（回灌给模型看，不必太长）。 */
const MAX_CALL_ERROR_CHARS = 400;
/**
 * 脚本结束后为「还在飞的 callTool」多等多久。
 * 不白等太久：等到了就能报出真实错误/拿到 logs；等不到就告诉模型「你没 await」。
 */
const PENDING_GRACE_MS = 3_000;
/** 最终结果字符上限（助手回灌给模型时另有 8000 的上限，这里给宽些，保住 trace）。 */
const MAX_RESULT_CHARS = 40_000;

/** 沙箱执行工具的方式：与助手共用同一个入口（内置 + 外部 MCP 都能调）。 */
export type SandboxToolRunner = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface JsSandboxCall {
  name: string;
  ok: boolean;
  ms: number;
  /** 失败时的原因（callTool 抛出来的那句话），让模型知道该改什么。 */
  error?: string;
}

export interface JsSandboxResult {
  /**
   * 脚本跑完且没出问题为 true；语法错/运行错/超时/调用超限/**脚本没跑完就结束**均为 false。
   *
   * 「脚本结束了但还有 callTool 在飞」也算 false：那种情况 result 往往是 null，
   * 报成功就变成了「查完了，没结果」的假阴性——实测助手就踩过这个坑。
   */
  ok: boolean;
  /** 脚本 `return` 的值（JSON 化后）。没 return 时是 null，此时看 logs。 */
  result: unknown;
  /** 出错原因（ok=false 时）。 */
  error?: string;
  /** `console.*` 的输出，按行。 */
  logs: string[];
  /** 脚本里每次 `callTool` 的轨迹，成功失败与耗时。 */
  calls: JsSandboxCall[];
  /** 实际耗时（毫秒）。 */
  ms: number;
  /** 结果被截断时的说明。 */
  truncated?: string;
  /** 给模型看的提示（没 return、有失败调用…），不是错误本身。 */
  notes?: string[];
  /** 脚本结束时仍在飞的 callTool 数。 */
  unawaited?: number;
}

/**
 * `workerData` 的载体；worker 源码里按字段名取，改动时两边一起改。
 * 注意源码是纯 JS 字符串，字段名保持一致即可，不做类型共享。
 *
 * 这里**只有执行侧需要的东西**：工具次数上限、调用轨迹由主线程掌握（它才是唯一
 * 知道每次调用成败的地方），worker 只管跑代码、报结果。
 */
interface SandboxWorkerData {
  code: string;
  syncTimeoutMs: number;
  maxLogLines: number;
  maxLogChars: number;
  maxResultChars: number;
  pendingGraceMs: number;
}

/**
 * Worker 源码。约束：**只能用单引号与字符串拼接**——它整体是一个模板字面量，
 * 里面出现反引号或 `${` 会被外层提前求值（踩过一次）。
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const util = require('node:util');

const cfg = workerData;
const logs = [];
const pending = new Map();
let seq = 0;
let logChars = 0;

function post(msg) {
  try { parentPort.postMessage(msg); } catch (e) { /* 传不出去只能放弃 */ }
}

// 序列化成 JSON 文本再回主线程：跨 realm 的值不走结构化克隆，避免遇到函数/循环引用时直接抛。
function toJson(value) {
  try {
    return JSON.stringify(value, function (k, v) {
      return typeof v === 'bigint' ? v.toString() : v;
    });
  } catch (e) {
    try { return JSON.stringify(String(value)); } catch (e2) { return '"<无法序列化>"'; }
  }
}

function fmt(args) {
  return args.map(function (a) {
    if (typeof a === 'string') return a;
    try { return util.inspect(a, { depth: 5, maxArrayLength: 80, breakLength: 120, compact: true }); }
    catch (e) { return String(a); }
  }).join(' ');
}

function pushLog(level, args) {
  if (logs.length >= cfg.maxLogLines || logChars >= cfg.maxLogChars) return;
  const line = '[' + level + '] ' + fmt(args);
  logChars += line.length;
  logs.push(line);
}

// 脚本创建但还没落定的异步工作（callTool / sleep）。脚本 resolve 时若这个集合非空，
// 说明有 fire-and-forget 的分支没有 await —— 那是「脚本没跑完」，不能报成功。
const outstanding = new Set();
let sleepers = 0;

function track(promise) {
  outstanding.add(promise);
  const drop = function () { outstanding.delete(promise); };
  // 两个分支都挂上：顺便替它们接住拒绝，不让它变成没人管的 unhandledRejection。
  promise.then(drop, drop);
  return promise;
}

function callTool(name, args) {
  let resolveFn;
  let rejectFn;
  const promise = new Promise(function (resolve, reject) {
    resolveFn = resolve;
    rejectFn = reject;
  });
  if (typeof name !== 'string' || !name) {
    rejectFn(new Error('callTool(name, args)：name 必须是非空字符串（工具名）'));
    return track(promise);
  }
  const id = ++seq;
  pending.set(id, { resolve: resolveFn, reject: rejectFn });
  post({ kind: 'call', id: id, name: name, args: args && typeof args === 'object' ? args : {} });
  return track(promise);
}

// 没被 await、也没人 catch 的异步错误（典型是 main() 没 await）：
// 默认会变成静默的 unhandledRejection，脚本看似成功、其实什么都没算出来。
const asyncErrors = [];

function recordAsyncError(reason) {
  if (asyncErrors.length >= 5) return;
  const message = reason && reason.message ? reason.message : String(reason);
  asyncErrors.push(message + locate(reason));
}

process.on('unhandledRejection', recordAsyncError);
process.on('uncaughtException', function (err) {
  recordAsyncError(err);
  finish(false, null, err, 0);
});

// 报错尽量带上用户代码的行号（wrapper 前缀不含换行，所以行号与用户写的行一一对应）。
// 用 indexOf 手抠而不是正则：这整段源码是外层模板字面量，正则里的反斜杠会被提前吃掉一层，
// 写 /assistant-sandbox.js:(d+)/ 实际会生成 (d+)，静默匹配不上。
function locate(err) {
  const stack = err && err.stack ? String(err.stack) : '';
  // 语法错的 stack 头是 'assistant-sandbox.js:2'，运行错里则是 'at assistant-sandbox.js:1:26'。
  const marker = 'assistant-sandbox.js:';
  const at = stack.indexOf(marker);
  if (at < 0) return '';
  let i = at + marker.length;
  let line = '';
  while (i < stack.length && stack[i] >= '0' && stack[i] <= '9') line += stack[i++];
  if (!line) return '';
  let col = '';
  if (stack[i] === ':') {
    let j = i + 1;
    while (j < stack.length && stack[j] >= '0' && stack[j] <= '9') col += stack[j++];
  }
  return '（第 ' + line + ' 行' + (col ? ':' + col : '') + '）';
}

function finish(ok, value, error, unawaited, unawaitedDesc) {
  let resultText = null;
  let truncated = null;
  let message = null;
  const notes = [];
  if (ok) {
    resultText = toJson(value);
    if (typeof resultText === 'string' && resultText.length > cfg.maxResultChars) {
      resultText = resultText.slice(0, cfg.maxResultChars);
      truncated = 'result 超过 ' + cfg.maxResultChars + ' 字符已截断';
    }
    if (value === undefined) {
      notes.push('脚本没有 return 值，result 是 null；要把结论带出来请显式 return。');
    }
  } else {
    const base = error && error.message ? error.message : String(error);
    message = base + locate(error);
  }

  // 两个都不算成功。两条信息都拼上：那个异步错误往往正是「没等完」的病因。
  if (asyncErrors.length) {
    ok = false;
    const head = '脚本里有未被处理的异步错误：' + asyncErrors[0];
    message = message ? message + '｜' + head : head;
  }
  if (unawaited > 0) {
    ok = false;
    const hint =
      '脚本在还有 ' + unawaited + ' 处异步工作（' + unawaitedDesc + '）没完成时就结束了' +
      '（忘了 await，或者定义了 main() 却没 return main()？）。' +
      'result 为 null 不代表没有结果，是脚本根本没等你查完。';
    message = message ? message + '｜' + hint : hint;
  }

  post({
    kind: 'done',
    ok: ok,
    resultText: resultText,
    error: message,
    truncated: truncated,
    notes: notes,
    unawaited: unawaited,
    logs: logs,
  });
}

// 主线程回包统一走 text 字段：ok=true 时是结果 JSON，ok=false 时是错误信息。
parentPort.on('message', function (msg) {
  if (!msg || msg.kind !== 'callResult') return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) {
    let value = null;
    try { value = msg.text ? JSON.parse(msg.text) : null; } catch (e) { value = msg.text; }
    p.resolve(value);
  } else {
    p.reject(new Error(msg.text || '工具调用失败'));
  }
});

const consoleShim = {};
['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
  consoleShim[level] = function () {
    pushLog(level, Array.prototype.slice.call(arguments));
  };
});

const sandbox = {
  callTool: callTool,
  sleep: function (ms) {
    const n = Math.min(Math.max(Number(ms) || 0, 0), 10000);
    sleepers += 1;
    // 被 await 的 sleep 会在脚本 resolve 前就减回去，只有 fire-and-forget 的会被算成未完成。
    return track(new Promise(function (r) {
      setTimeout(function () { sleepers -= 1; r(); }, n);
    }));
  },
  console: consoleShim,
};

// codeGeneration.strings = false：关掉这个上下文里的 eval / new Function，
// 掐掉最常见的一条从「普通对象」爬回宿主的链子。vm.Script 不受影响。
const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

// 包一层 async IIFE 以支持顶层 await；用户代码从第 1 行开始，报错行号不会错位。
const wrapped = '(async () => {' + cfg.code + '\\n})()';

// 脚本本体结束后，给还挂着的 callTool 一点时间把结果收回来（logs 更完整、失败原因也拿得到），
// 但不无限等——总的硬超时在主线程那边兜底。
function settlePending(cb) {
  const unawaited = outstanding.size;
  const parts = [];
  if (pending.size) parts.push('callTool × ' + pending.size);
  if (sleepers) parts.push('sleep × ' + sleepers);
  const desc = parts.join('、') || '未明了';
  let done = false;
  const go = function () {
    if (done) return;
    done = true;
    cb(unawaited, desc);
  };
  if (unawaited === 0) {
    // 即使没有在飞工作，也要放过一个事件循环轮次再收工：沙箱里可能还有没人管的
    // 异步拒绝在排队，立刻返回会让 worker 被主线程 terminate 掉，错误就静默丢了。
    setTimeout(go, 0);
    return;
  }
  // 等它们落定（logs 更完整、失败原因也拿得到），但不无限等：grace 到就收工，
  // 总的硬超时还在主线程那边兜底。
  Promise.allSettled(Array.from(outstanding)).then(go, go);
  setTimeout(go, cfg.pendingGraceMs);
}

try {
  const script = new vm.Script(wrapped, { filename: 'assistant-sandbox.js' });
  const running = script.runInContext(context, { timeout: cfg.syncTimeoutMs });
  Promise.resolve(running).then(
    function (value) {
      settlePending(function (unawaited, desc) { finish(true, value, null, unawaited, desc); });
    },
    function (err) { finish(false, null, err, 0, null); },
  );
} catch (err) {
  finish(false, null, err, 0, null);
}
`;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * 在沙箱里跑一段模型写的 JS。
 *
 * @param code     脚本源码（可含顶层 `await`，用 `return` 给出结果）。
 * @param callTool 唯一的对外通道：脚本里 `callTool(name, args)` 最终执行它。
 * @param timeoutMs 执行时限，缺省 {@link JS_SANDBOX_DEFAULT_TIMEOUT_MS}。
 *
 * **不抛异常**：语法错、运行错、超时、调用超限、以及「脚本没跑完就结束」都压成
 * `ok:false` 的结果返回——这样 `logs` / `calls` / `notes` 能一起回灌给模型，它自己
 * 看着报错改代码重试，而不是只拿到一句「执行失败」，更不是把 null 当成「查无结果」。
 */
export async function runJsSandbox(
  code: string,
  callTool: SandboxToolRunner,
  timeoutMs: number = JS_SANDBOX_DEFAULT_TIMEOUT_MS,
): Promise<JsSandboxResult> {
  const startedAt = Date.now();
  const fail = (
    error: string,
    logs: string[] = [],
    calls: JsSandboxCall[] = [],
  ): JsSandboxResult => ({
    ok: false,
    result: null,
    error,
    logs,
    calls,
    ms: Date.now() - startedAt,
  });

  if (typeof code !== 'string' || !code.trim()) return fail('code 为空');
  if (code.length > MAX_CODE_CHARS) {
    return fail(`code 过长（${code.length} 字符，上限 ${MAX_CODE_CHARS}）`);
  }

  const limit = clamp(timeoutMs, 1_000, JS_SANDBOX_MAX_TIMEOUT_MS);
  const workerData: SandboxWorkerData = {
    code,
    syncTimeoutMs: limit,
    maxLogLines: MAX_LOG_LINES,
    maxLogChars: MAX_LOG_CHARS,
    maxResultChars: MAX_RESULT_CHARS,
    pendingGraceMs: PENDING_GRACE_MS,
  };

  const calls: JsSandboxCall[] = [];

  return await new Promise<JsSandboxResult>((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData });

    const settle = (result: JsSandboxResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      void worker.terminate(); // 正常结束也 terminate：worker 里可能还有未清的 timer 在挂着
      resolve(result);
    };

    // 硬超时。vm 的 timeout 只管同步段，await 之后要靠这一步兜底。
    const killTimer = setTimeout(() => {
      settle(fail(`脚本执行超过 ${limit}ms 已中止（可能有死循环或卡住的 await）`, [], calls));
    }, limit);

    /**
     * 脚本里的一次 `callTool`。次数上限与调用轨迹都记在这里——只有主线程知道每次调用
     * 的成败，worker 那边看不到，所以策略留在这一侧。
     */
    const handleCall = async (
      id: number,
      name: string,
      args: Record<string, unknown>,
    ): Promise<void> => {
      const reply = (ok: boolean, text: string): void => {
        if (settled) return;
        worker.postMessage({ kind: 'callResult', id, ok, text });
      };
      // 先记账再执行：并行的 callTool 也要一起算进上限。
      if (calls.length >= MAX_TOOL_CALLS) {
        calls.push({ name, ok: false, ms: 0 });
        reply(
          false,
          `本次脚本调用工具次数已达上限 ${MAX_TOOL_CALLS} 次。要处理更多数据就拆成多轮对话，每轮少调几次。`,
        );
        return;
      }
      const entry: JsSandboxCall = { name, ok: false, ms: 0 };
      calls.push(entry);
      // 禁止套娃：沙箱里再开沙箱会变成 worker 递归，直接把这条路封掉。
      if (name === 'run_js') {
        reply(
          false,
          'run_js 不能在沙箱内再调用（会递归开 worker）。要分段处理就把它拆成多轮主对话。',
        );
        return;
      }
      const t0 = Date.now();
      try {
        const value = await callTool(name, args ?? {});
        let text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        if (text === undefined) text = 'null';
        if (text.length > MAX_CALL_RESULT_CHARS) {
          // 从中间截断会得到非法 JSON，所以明确包一层：让脚本看得见「你拿到的是预览」。
          text = JSON.stringify({
            __truncated: true,
            note: `工具结果超过 ${MAX_CALL_RESULT_CHARS} 字符，这里只是前缀预览；请缩小查询范围（加 limit / 分批）再调。`,
            preview: text.slice(0, MAX_CALL_RESULT_CHARS),
          });
        }
        entry.ok = true;
        entry.ms = Date.now() - t0;
        reply(true, text);
      } catch (error) {
        entry.ms = Date.now() - t0;
        // 原因存进轨迹：脚本自己 catch 了也好，没 catch 也好，模型都能从 calls[].error
        // 看到「到底为什么失败」，而不是只拿到一句「有一次调用失败了」。
        entry.error = (error instanceof Error ? error.message : String(error)).slice(
          0,
          MAX_CALL_ERROR_CHARS,
        );
        reply(false, entry.error);
      }
    };

    worker.on('message', (msg: SandboxWorkerMessage) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'call') {
        void handleCall(Number(msg.id), String(msg.name), msg.args ?? {});
        return;
      }
      if (msg.kind === 'done') {
        const notes = [...(msg.notes ?? [])];
        // 把失败调用汇总成一条提示：模型最容易忽略的地方，明着写一遍。
        const failed = calls.filter((c) => !c.ok);
        if (failed.length) {
          const detail = failed
            .slice(0, 3)
            .map((c) => `${c.name}：${c.error ?? '原因未知'}`)
            .join('；');
          notes.push(
            `本次有 ${failed.length} 次工具调用失败——${detail}${failed.length > 3 ? '（其余略）' : ''}`,
          );
        }
        settle({
          ok: msg.ok === true,
          result: msg.resultText ? safeParse(msg.resultText) : null,
          error: msg.error ?? undefined,
          logs: msg.logs ?? [],
          calls,
          ms: Date.now() - startedAt,
          truncated: msg.truncated ?? undefined,
          notes: notes.length ? notes : undefined,
          unawaited: msg.unawaited || undefined,
        });
      }
    });

    worker.on('error', (error) => {
      settle(fail(`沙箱进程异常：${error.message}`, [], calls));
    });

    // 没发 done 就退出 = 崩了（进程级错误，如 OOM）。已 settle 时这里是 no-op。
    worker.on('exit', (code) => {
      settle(fail(`沙箱进程意外退出（code ${code}）`, [], calls));
    });
  });
}

/** worker → 主线程的消息形状（worker 源码是纯 JS，这里只做描述性声明）。 */
interface SandboxWorkerMessage {
  kind?: 'call' | 'done';
  id?: number;
  name?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  resultText?: string | null;
  error?: string | null;
  truncated?: string | null;
  notes?: string[];
  unawaited?: number;
  logs?: string[];
}

/** 解析 worker 回传的结果文本；解析不了就原样返回，别让沙箱自己抛错。 */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
