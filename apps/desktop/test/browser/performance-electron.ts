import { app, BrowserWindow, ipcMain } from 'electron';
import { MONITOR_RESPONSE } from '../../src/shared/performance_monitor';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  PerformanceMonitor,
  DEFAULT_MONITOR_SETTINGS,
  type MonitorMode,
} from '@weq/service/performance';
import { createDesktopCollector } from '../../src/main/performance_monitor';

const root = process.env.WEQ_PERFORMANCE_SMOKE_ROOT!;
app.setPath('userData', join(root, 'profile'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
async function main() {
  let window: BrowserWindow | undefined, monitor: PerformanceMonitor | undefined;
  const syncSpans: Array<{ at: number; duration: number }> = [];
  const receiveSpans = (
    _event: Electron.IpcMainEvent,
    _sequence: unknown,
    raw: { syncSpans?: Array<{ at: number; duration: number }> } | null,
  ) => {
    if (raw?.syncSpans) syncSpans.push(...raw.syncSpans);
  };
  ipcMain.on(MONITOR_RESPONSE, receiveSpans);
  try {
    window = new BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      webPreferences: {
        preload: join(root, 'preload.cjs'),
        sandbox: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    const contents = window.webContents;
    monitor = new PerformanceMonitor(
      root,
      createDesktopCollector(
        () => contents.id,
        () => ({ database: null }),
        () => monitor?.recordEvent('renderer-exit'),
      ),
    );
    await monitor.ready;
    assert.equal((await monitor.status()).error, null, '真实 Electron Worker 启动失败');
    if (process.env.WEQ_PERFORMANCE_SCENE_URL) {
      await contents.loadURL(process.env.WEQ_PERFORMANCE_SCENE_URL);
      const deadline = Date.now() + 30_000;
      while (
        !(await contents.executeJavaScript(
          'Boolean(window.timelineTest?.beginEntry && document.querySelector(".message-line"))',
        ))
      ) {
        assert.ok(Date.now() < deadline, '实际 ChatPane 夹具未就绪');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await contents.executeJavaScript(`(() => {
      window.performanceSceneErrors=[];window.performanceResizeWarnings=0;
      window.addEventListener('error',event=>{if(event.message==='ResizeObserver loop completed with undelivered notifications.')window.performanceResizeWarnings++;else window.performanceSceneErrors.push(event.message)});
      const tasks=[];new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>({at:e.startTime,duration:e.duration})))).observe({type:'longtask'});
      const frame=()=>new Promise(requestAnimationFrame);
      window.runPerformanceScene=async()=>{
        window.timelineTest.beginEntry();await frame();await frame();
        const began=performance.now();window.timelineTest.entryStage(1200,true);await frame();await frame();
        const row=document.querySelector('.message-line');if(!row||!row.getClientRects().length)throw new Error('消息首帧未真实绘制');
        const firstFrameMs=performance.now()-began,frames=[],latencies=[];
        const scroll=document.querySelector('.message-scroll'),input=document.querySelector('.composer-editor[contenteditable="true"]');
        if(!input)throw new Error('实际输入框缺失');
        let last=performance.now();for(let i=0;i<30;i++){
          scroll.scrollTop-=72;const start=performance.now();input.textContent='输入 '+i;input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:String(i)}));
          await frame();const now=performance.now();latencies.push(now-start);frames.push(now-last);last=now;
        }
        await new Promise(r=>setTimeout(r,0));return{firstFrameMs,frames,input:latencies,longTasks:tasks.filter(t=>t.at>=began).map(t=>({at:performance.timeOrigin+t.at,duration:t.duration}))};
      };
    })()`);
    } else await contents.loadFile(join(root, 'scene.html'));
    const rows: Array<{
      mode: MonitorMode;
      firstFrameMs: number;
      frames: number[];
      input: number[];
      longTasks: Array<{ at: number; duration: number }>;
    }> = [];
    await monitor.configure({ ...DEFAULT_MONITOR_SETTINGS, mode: 'off' });
    for (let warmup = 0; warmup < 3; warmup++)
      await contents.executeJavaScript('window.runPerformanceScene()');
    for (let round = 0; round < 40; round++)
      for (const mode of (round % 2
        ? ['full', 'light', 'off']
        : ['off', 'light', 'full']) as MonitorMode[]) {
        await monitor.configure({
          ...DEFAULT_MONITOR_SETTINGS,
          mode,
          fullUntil: mode === 'full' ? Date.now() + 3600_000 : null,
        });
        rows.push({ mode, ...(await contents.executeJavaScript('window.runPerformanceScene()')) });
        await monitor.flush();
      }
    const status = await monitor.status();
    const history = await monitor.history({
      from: Date.now() - 600_000,
      to: Date.now() + 1,
      buckets: 400,
    });
    assert.ok(history.points.length > 0);
    const detail = await monitor.detail(history.points.at(-1)!.id);
    assert.ok(detail?.processes?.some((proc) => proc.metrics.heapBytes !== null));
    const fullExport = await monitor.exportPage(Date.now() - 600_000, Date.now() + 1);
    assert.ok(fullExport.rows.some((row) => row.includes('animationDetails')));
    const screenshot = await contents.capturePage();
    assert.equal(screenshot.isEmpty(), false);
    const bitmap = screenshot.toBitmap(),
      colors = new Set<string>();
    const step = Math.max(4, Math.floor(bitmap.length / 2048 / 4) * 4);
    for (let i = 0; i < bitmap.length; i += step)
      colors.add(bitmap.subarray(i, i + 4).toString('hex'));
    assert.ok(colors.size > 8, '实际消息绘制截图为空或只有背景色');
    await writeFile(join(root, 'electron-scene.png'), screenshot.toPNG());
    const p95 = (values: number[]) =>
      values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
    const summary = Object.fromEntries(
      (['off', 'light', 'full'] as MonitorMode[]).map((mode) => {
        const data = rows.filter((row) => row.mode === mode);
        return [
          mode,
          {
            firstFrameP95: p95(data.map((row) => row.firstFrameMs)),
            scrollP95: p95(data.flatMap((row) => row.frames)),
            inputP95: p95(data.flatMap((row) => row.input)),
            longTasks: data
              .flatMap((row) => row.longTasks)
              .map((task) => ({
                ...task,
                monitorOverlap: syncSpans.some(
                  (span) => span.at < task.at + task.duration && span.at + span.duration > task.at,
                ),
              })),
          },
        ];
      }),
    );
    const baseline = summary.off!,
      light = summary.light!,
      full = summary.full!;
    const checks = (candidate: typeof light) => ({
      firstFrame:
        candidate.firstFrameP95 <=
        baseline.firstFrameP95 + Math.max(2, baseline.firstFrameP95 * 0.05),
      scroll: candidate.scrollP95 <= baseline.scrollP95 + Math.max(2, baseline.scrollP95 * 0.05),
      input: candidate.inputP95 <= baseline.inputP95 + Math.max(2, baseline.inputP95 * 0.05),
      longTasks: candidate.longTasks.every((task) => !task.monitorOverlap),
    });
    const report = {
      environment: { electron: process.versions.electron, node: process.versions.node },
      synthetic: true,
      actualChatPane: !!process.env.WEQ_PERFORMANCE_SCENE_URL,
      summary,
      checks: { light: checks(light), full: checks(full) },
      samples: history.points.length,
      lastSyncMs: status.lastSyncMs,
      lastWaitMs: status.lastWaitMs,
      detailBackoffUntil: status.detailBackoffUntil,
      rendererWarnings: await contents.executeJavaScript(
        '({ resizeObserver: window.performanceResizeWarnings ?? 0, errors: window.performanceSceneErrors ?? [] })',
      ),
      samplingSpans: {
        count: syncSpans.length,
        maxMs: Math.max(0, ...syncSpans.map((span) => span.duration)),
      },
    };
    await writeFile(join(root, 'electron-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    assert.ok(syncSpans.length > 0, '未收到真实 preload 同步采样区间');
    assert.ok(report.samplingSpans.maxMs < 50, '采样自身产生了至少 50ms 的连续同步任务');
    assert.deepEqual(report.rendererWarnings.errors, []);
    assert.ok(
      Object.values(report.checks.light).every(Boolean),
      '轻量采集开销超出合成场景验收目标',
    );
    assert.ok(Object.values(report.checks.full).every(Boolean), '完整采集开销超出合成场景验收目标');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    ipcMain.off(MONITOR_RESPONSE, receiveSpans);
    await monitor?.dispose();
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
void app.whenReady().then(main);
