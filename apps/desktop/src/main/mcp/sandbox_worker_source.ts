/** 字符串 worker 避免构建产物寻址差异；宿主与解释器之间只传 JSON 文本。 */
export const SANDBOX_WORKER_SOURCE = String.raw`
const { parentPort, workerData: cfg } = require('node:worker_threads');
const pending = new Map();
const logs = [];
let seq = 0;
let logChars = 0;
let finished = false;
let vm;
const deadline = Date.now() + cfg.limit;
const stringify = (value) => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? String(v) : v);
function log(level, text) {
  if (logs.length >= 200 || logChars >= 20000) return;
  const line = ('[' + level + '] ' + text).slice(0, 20000 - logChars);
  logs.push(line); logChars += line.length;
}
function request(name, text) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ kind: 'call', id, name, args: JSON.parse(text) });
  });
}
parentPort.on('message', (msg) => {
  if (!msg || msg.kind !== 'callResult') return;
  const call = pending.get(msg.id);
  if (!call) return;
  pending.delete(msg.id);
  if (msg.ok) call.resolve(msg.text); else call.reject(new Error(msg.text));
});
function finish(ok, resultText, error, unawaited = 0) {
  if (finished) return;
  finished = true;
  let truncated;
  if (resultText && resultText.length > 40000) {
    resultText = stringify({ preview: resultText.slice(0, 40000) });
    truncated = 'result 超过 40000 字符已截断';
  }
  parentPort.postMessage({ kind: 'done', ok: ok && !unawaited, resultText, error, logs, unawaited, truncated,
    notes: unawaited ? ['脚本结束时仍有异步工作，请 await 所有 callTool / sleep。'] : undefined });
}
process.on('unhandledRejection', (error) => finish(false, null, String(error)));
async function main() {
  if (cfg.unrestricted) {
    // 这是用户明确授权的宿主执行模式，不宣称隔离，保留 Node 全部能力。
    const outstanding = new Set();
    const track = (promise) => {
      outstanding.add(promise);
      promise.then(() => outstanding.delete(promise), () => outstanding.delete(promise));
      return promise;
    };
    const callTool = (name, args = {}) => track(request(name, stringify(args)).then(JSON.parse));
    const sleep = (ms) => track(new Promise(r => setTimeout(r, Math.min(Math.max(Number(ms) || 0, 0), 10000))));
    const consoleShim = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, (...args) => log(level, args.map(a => typeof a === 'string' ? a : stringify(a)).join(' '))]));
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    const value = await new AsyncFunction('callTool', 'sleep', 'console', 'require', cfg.code)(callTool, sleep, consoleShim, require);
    const unawaited = outstanding.size;
    if (unawaited) await Promise.race([Promise.allSettled([...outstanding]), new Promise(r => setTimeout(r, 3000))]);
    finish(true, stringify(value) ?? 'null', undefined, unawaited); return;
  }
  const { getQuickJS } = require(cfg.quickjsPath);
  const QuickJS = await getQuickJS();
  vm = QuickJS.newContext();
  vm.runtime.setMemoryLimit(32 * 1024 * 1024);
  vm.runtime.setMaxStackSize(256 * 1024);
  vm.runtime.setInterruptHandler(() => Date.now() >= deadline);
  function pump() {
    if (finished) return;
    const jobs = vm.runtime.executePendingJobs();
    if (jobs.error) {
      const error = vm.dump(jobs.error); jobs.error.dispose();
      finish(false, null, stringify(error));
    }
  }
  function bridge(name, work) {
    const handle = vm.newFunction(name, (...args) => {
      const deferred = vm.newPromise();
      let promise;
      try { promise = work(...args); } catch (error) { promise = Promise.reject(error); }
      Promise.resolve(promise).then(
        text => {
          if (finished) return;
          const value = vm.newString(text); deferred.resolve(value); value.dispose();
          deferred.dispose(); pump();
        },
        error => {
          if (finished) return;
          const value = vm.newError(error instanceof Error ? error.message : String(error));
          deferred.reject(value); value.dispose(); deferred.dispose(); pump();
        },
      );
      return deferred.handle;
    });
    vm.setProp(vm.global, name, handle); handle.dispose();
  }
  bridge('__call', (name, args) => request(vm.getString(name), vm.getString(args)));
  bridge('__sleep', (ms) => new Promise(resolve => setTimeout(() => resolve('null'), Math.min(Math.max(vm.getNumber(ms) || 0, 0), 10000))));
  const logger = vm.newFunction('__log', (level, text) => { log(vm.getString(level), vm.getString(text)); });
  vm.setProp(vm.global, '__log', logger); logger.dispose();
  const setup = vm.evalCode(
    'globalThis.__outstanding = 0; globalThis.__unawaited = 0;' +
    'const track = async (p) => { __outstanding++; try { return await p; } finally { __outstanding--; } };' +
    'globalThis.callTool = (name, args = {}) => track(__call(String(name), JSON.stringify(args))).then(JSON.parse);' +
    'globalThis.sleep = ms => track(__sleep(Number(ms)));' +
    'globalThis.console = Object.fromEntries(["log","info","warn","error","debug"].map(level => [level, (...args) => __log(level, args.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "))]));'
  );
  vm.unwrapResult(setup).dispose();
  const evaluated = vm.evalCode('(async () => {' + cfg.code + '\n})().then(value => { __unawaited = __outstanding; return JSON.stringify(value, (_k, v) => typeof v === "bigint" ? String(v) : v) ?? "null"; })', 'assistant-sandbox.js');
  if (evaluated.error) {
    const error = vm.dump(evaluated.error); evaluated.error.dispose();
    finish(false, null, error.message || stringify(error)); return;
  }
  const promiseHandle = evaluated.value;
  const resolved = vm.resolvePromise(promiseHandle);
  pump();
  const result = await resolved;
  promiseHandle.dispose();
  if (result.error) {
    const error = vm.dump(result.error); result.error.dispose();
    finish(false, null, error.message || stringify(error)); return;
  }
  const text = vm.getString(result.value); result.value.dispose();
  const count = vm.getProp(vm.global, '__unawaited');
  const unawaited = vm.getNumber(count); count.dispose();
  if (unawaited) await new Promise(resolve => setTimeout(resolve, 30));
  finish(true, text, unawaited ? '脚本没有等待全部异步工作' : undefined, unawaited);
}
main().catch(error => finish(false, null, error.message || String(error)));
`;
