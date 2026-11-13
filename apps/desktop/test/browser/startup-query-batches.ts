import {
  nextStartupQueryStage,
  scheduleStartupQueryBatch,
  type StartupQueryStage,
} from '../../src/renderer/src/lib/startupQueries';
import logo from '../../../../resources/brand/logo.png';

let stage: StartupQueryStage = 0;
let firstReady = false;
let settled = false;
let busy = false;
let cancel: (() => void) | undefined;
const requests: Array<{ stage: number; at: number; firstPaint: number | undefined }> = [];

function advance() {
  const next = nextStartupQueryStage(stage, firstReady, settled);
  if (next === null) return;
  cancel = scheduleStartupQueryBatch(
    () => {
      stage = next;
      settled = false;
      requests.push({
        stage,
        at: performance.now(),
        firstPaint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      });
      document.getElementById('batches')!.textContent = `后台批次 ${stage}`;
    },
    () => !busy,
  );
}

Object.assign(window, {
  startupBatchQa: {
    loaded: true,
    requests,
    firstPage() {
      document.getElementById('root')!.innerHTML =
        `<main id="first-page" style="padding:24px;max-width:560px"><img src="${logo}" alt="WeQ" width="48" height="50"><h1 style="font-size:22px">合成会话首屏</h1><div style="padding:16px;background:#d7eee3;border-bottom:1px solid #51866c">当前会话已经可见</div><p id="batches"></p></main>`;
      firstReady = true;
      advance();
    },
    complete(expected: number) {
      if (stage !== expected) throw new Error('批次不匹配');
      settled = true;
      advance();
    },
    busy(value: boolean) {
      busy = value;
    },
    cancel() {
      cancel?.();
    },
  },
});
