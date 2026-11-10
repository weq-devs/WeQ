import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
await mkdir(resolve(root, 'node_modules/.cache'), { recursive: true });
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/timeline-scroll-'));
const baseline = process.env.WEQ_TIMELINE_BASELINE_REF;
const width = Number(process.env.WEQ_SCROLL_WIDTH ?? 1280);
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: { entries: ['test/browser/timeline.html'] },
  plugins: [
    ...(baseline
      ? [
          {
            name: 'timeline-baseline',
            enforce: 'pre',
            load(id) {
              if (id === resolve(root, 'src/renderer/src/hooks/useVirtualTimeline.ts'))
                return execFileSync(
                  'git',
                  ['show', `${baseline}:apps/desktop/src/renderer/src/hooks/useVirtualTimeline.ts`],
                  { cwd: root, encoding: 'utf8' },
                );
            },
          },
        ]
      : []),
    react(),
    tailwind(),
  ],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'trpc.stub.ts') },
      {
        find: /^@weq\/agentlab$/,
        replacement: resolve(root, '../../packages/agentlab/src/model_selection.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [resolve(root, '../..')] } },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?count=25`,
  );
  await page.waitForSelector('[data-message-id="row-1001"]');
  await page.evaluate(() => {
    window.scrollProbe = { active: false, phase: '', samples: [] };
    const sample = () => {
      const state = window.scrollProbe,
        scroll = document.querySelector('.message-scroll');
      if (state.active && scroll && state.samples.length < 2000) {
        const bounds = scroll.getBoundingClientRect();
        const rows = [...scroll.querySelectorAll('.weq-virtual-timeline-row')];
        const visible = rows
          .map((row) => row.getBoundingClientRect())
          .filter((rect) => rect.bottom > bounds.top && rect.top < bounds.bottom);
        const top = Math.min(...visible.map((rect) => rect.top));
        const bottom = Math.max(...visible.map((rect) => rect.bottom));
        state.samples.push({
          phase: state.phase,
          offset: scroll.scrollTop,
          mounted: rows.length,
          visible: visible.length,
          blankTop: Math.max(0, top - bounds.top),
          blankBottom: Math.max(0, bounds.bottom - bottom),
          blank: !visible.length || top - bounds.top > 48 || bounds.bottom - bottom > 48,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const frames = (count) =>
    page.evaluate(
      (count) =>
        new Promise((resolve) => {
          const next = () => (--count > 0 ? requestAnimationFrame(next) : resolve());
          requestAnimationFrame(next);
        }),
      count,
    );
  await page.evaluate(() => {
    window.scrollProbe.active = true;
    window.scrollProbe.phase = 'prepend-cross-threshold';
    window.timelineTest.prepend();
  });
  await frames(8);
  await page.evaluate(() => {
    window.scrollProbe.active = false;
    window.timelineTest.setCount(3000);
  });
  await frames(4);
  await page.evaluate(() => window.timelineTest.jump('row-2000'));
  await page.waitForSelector('[data-message-id="row-2000"]');
  await frames(3);
  await page.mouse.move(width / 2, 450);
  await page.evaluate(() => {
    window.scrollProbe.phase = 'fast-wheel';
    window.scrollProbe.active = true;
  });
  for (const delta of [1200, 1800, 2400, 1800, -2400, -1800, -2400, 2400, -1800, 1200]) {
    await page.mouse.wheel(0, delta);
    await frames(2);
  }
  await frames(4);
  const samples = await page.evaluate(() => {
    window.scrollProbe.active = false;
    return window.scrollProbe.samples;
  });
  const report = {
    width,
    baseline: baseline ?? null,
    samples: samples.length,
    blankFrames: samples.filter((sample) => sample.blank),
    maxMounted: Math.max(...samples.map((sample) => sample.mounted)),
    offsets: [...new Set(samples.map((sample) => Math.round(sample.offset)))],
  };
  if (process.env.WEQ_SCROLL_REPORT)
    await writeFile(
      process.env.WEQ_SCROLL_REPORT,
      JSON.stringify({ ...report, frames: samples }, null, 2),
    );
  console.log(JSON.stringify(report));
  if (report.blankFrames.length) throw new Error('快速滚动出现未覆盖视口');
  if (report.maxMounted >= 150) throw new Error('预挂载恢复为大规模全量挂载');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
