type Job = { run: () => unknown; after: number; canRun: () => boolean; module: boolean };

const jobs = new Set<Job>();
const activityEvents = ['pointerdown', 'keydown', 'input', 'wheel', 'touchmove', 'scroll'];
export const BACKGROUND_INTERACTION_SETTLE_MS = 200;
let timer: number | undefined;
let idle: number | undefined;
let running = false;
let nextModuleAt = 0;
let listening = false;
let navigationBusy = false;
let heldUntil = 0;

function clearScheduled() {
  window.clearTimeout(timer);
  timer = undefined;
  if (idle !== undefined) window.cancelIdleCallback(idle);
  idle = undefined;
}

function activity() {
  heldUntil = performance.now() + BACKGROUND_INTERACTION_SETTLE_MS;
  // 已有计时器醒来后会按最新手势时间重新等待。每次滚动不必遍历任务或重建计时器。
  if (timer === undefined) schedule();
}

function visibilityChanged() {
  if (!document.hidden)
    nextModuleAt = Math.max(
      nextModuleAt,
      performance.now() + (typeof window.requestIdleCallback === 'function' ? 0 : 80),
    );
  schedule();
}

function listen(enabled: boolean) {
  if (listening === enabled) return;
  listening = enabled;
  for (const event of activityEvents) {
    if (enabled) window.addEventListener(event, activity, { capture: true, passive: true });
    else window.removeEventListener(event, activity, true);
  }
  if (enabled) {
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('weq-remote-startup', schedule);
  } else {
    document.removeEventListener('visibilitychange', visibilityChanged);
    window.removeEventListener('weq-remote-startup', schedule);
    heldUntil = 0;
    nextModuleAt = 0;
  }
}

function schedule() {
  clearScheduled();
  if (!jobs.size) {
    if (!running) listen(false);
    return;
  }
  if (document.hidden || navigationBusy) return;
  const ready = [...jobs].filter((job) => (!job.module || !running) && job.canRun());
  if (!ready.length) return;
  const wait = Math.max(
    0,
    heldUntil - performance.now(),
    Math.min(...ready.map((job) => Math.max(job.after, job.module ? nextModuleAt : 0))) -
      performance.now(),
  );
  if (wait > 0)
    timer = window.setTimeout(() => {
      timer = undefined;
      if (typeof window.requestIdleCallback === 'function') schedule();
      else runNext();
    }, wait);
  else if (typeof window.requestIdleCallback === 'function')
    idle = window.requestIdleCallback(runNext);
  else timer = window.setTimeout(runNext, 0);
}

function runNext() {
  timer = idle = undefined;
  if (document.hidden || navigationBusy || performance.now() < heldUntil) {
    schedule();
    return;
  }
  const job = [...jobs].find(
    (item) =>
      item.after <= performance.now() &&
      (!item.module || (!running && performance.now() >= nextModuleAt)) &&
      item.canRun(),
  );
  if (!job) {
    schedule();
    return;
  }
  jobs.delete(job);
  if (job.module) running = true;
  // 模块下载共用一个槽，但不占住可见行等业务读取；不把慢预热变成新的查询前置。
  void Promise.resolve()
    .then(job.run)
    .catch(() => {})
    .finally(() => {
      if (job.module) {
        running = false;
        nextModuleAt =
          performance.now() + (typeof window.requestIdleCallback === 'function' ? 0 : 80);
      }
      schedule();
    });
  if (!job.module) schedule();
}

export function setBackgroundNavigationBusy(busy: boolean) {
  navigationBusy = busy;
  schedule();
}

/** 后台查询与代码预热共用队列，输入、滚动、转场和后台状态优先。 */
export function scheduleBackgroundLoad(
  run: () => unknown,
  delay = 300,
  canRun = () => true,
): () => void {
  return enqueue(run, delay, canRun, false);
}

export function scheduleBackgroundModule(
  run: () => unknown,
  delay: number,
  canRun: () => boolean,
): () => void {
  return enqueue(run, delay, canRun, true);
}

function enqueue(run: () => unknown, delay: number, canRun: () => boolean, module: boolean) {
  const job = { run, after: performance.now() + delay, canRun, module };
  jobs.add(job);
  listen(true);
  schedule();
  return () => {
    jobs.delete(job);
    schedule();
  };
}
