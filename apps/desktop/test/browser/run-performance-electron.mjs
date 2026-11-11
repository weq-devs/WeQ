import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
const require = createRequire(import.meta.url),
  root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await mkdtemp(join(tmpdir(), 'weq-performance-electron-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-performance-timeline'),
  optimizeDeps: { entries: ['test/browser/performance-timeline.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
      {
        find: /^@weq\/agentlab$/,
        replacement: resolve(root, '../../packages/agentlab/src/model_selection.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [resolve(root, '../..')] },
  },
});
try {
  await server.listen();
  await mkdir(join(directory, 'profile'));
  await build({
    entryPoints: [join(root, 'test/browser/performance-electron.ts')],
    outfile: join(directory, 'main.mjs'),
    platform: 'node',
    format: 'esm',
    bundle: true,
    external: ['electron'],
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  await build({
    entryPoints: [join(root, 'test/browser/performance-electron-preload.ts')],
    outfile: join(directory, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    bundle: true,
    external: ['electron'],
  });
  await writeFile(
    join(directory, 'scene.html'),
    `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;margin:16px;background:#fff;color:#222}#scroll{height:600px;overflow:auto}.message-line{padding:8px;border-bottom:1px solid #ddd}input{width:80%;padding:8px}</style><main data-weq-diagnostic-view="messages" class="weq-chathome"><input id="input"><div id="scroll" class="message-scroll"></div></main><script>
const scroll=document.getElementById('scroll'),input=document.getElementById('input');
const tasks=[];new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>({at:e.startTime,duration:e.duration})))).observe({type:'longtask'});
const frame=()=>new Promise(requestAnimationFrame);
window.runPerformanceScene=async()=>{const began=performance.now();scroll.replaceChildren();let fragment=document.createDocumentFragment();for(let i=0;i<1200;i++){const row=document.createElement('div');row.className='message-line';row.textContent='合成消息 '+i+' · 性能监视绘制测试';fragment.append(row)}scroll.append(fragment);await frame();await frame();const firstFrameMs=performance.now()-began;const frames=[],latencies=[];let last=performance.now();for(let i=0;i<30;i++){scroll.scrollTop+=72;const start=performance.now();input.value='输入 '+i;input.dispatchEvent(new Event('input',{bubbles:true}));await frame();const now=performance.now();latencies.push(now-start);frames.push(now-last);last=now}await new Promise(r=>setTimeout(r,0));return{firstFrameMs,frames,input:latencies,longTasks:tasks.filter(t=>t.at>=began).map(t=>t.duration)}};
</script>`,
  );
  const child = spawn(require('electron'), [join(directory, 'main.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      WEQ_PERFORMANCE_SMOKE_ROOT: directory,
      WEQ_PERFORMANCE_SCENE_URL: `http://127.0.0.1:${server.httpServer.address().port}/test/browser/performance-timeline.html?count=1200&cached-bubbles=1`,
    },
    stdio: 'inherit',
  });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 120_000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  clearTimeout(deadline);
  if (process.env.WEQ_PERFORMANCE_ARTIFACTS) {
    await mkdir(process.env.WEQ_PERFORMANCE_ARTIFACTS, { recursive: true });
    for (const file of ['electron-result.json', 'electron-scene.png'])
      await cp(join(directory, file), join(process.env.WEQ_PERFORMANCE_ARTIFACTS, file)).catch(
        () => {},
      );
  }
  process.exitCode = Number(code ?? 1);
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
