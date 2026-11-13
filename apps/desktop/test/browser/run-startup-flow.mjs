import assert from 'node:assert/strict';
import { createServer, build as buildVite } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const fixture = `/@fs/${resolve(root, 'test/browser/startup-flow.tsx')}`;
const config = {
  configFile: false,
  root: resolve(root, 'src/renderer'),
  cacheDir: resolve(root, 'node_modules/.vite-startup-flow'),
  optimizeDeps: { entries: [resolve(root, 'test/browser/startup-flow.tsx')] },
  plugins: [
    {
      name: 'startup-test-entry',
      transformIndexHtml: {
        order: 'pre',
        handler: (html, context) =>
          context.originalUrl?.includes('static=1')
            ? html.replace('<script type="module" src="/src/main.tsx"></script>', '')
            : html.replace('/src/main.tsx', fixture),
      },
    },
    react(),
    tailwind(),
  ],
  resolve: {
    alias: {
      '@renderer': resolve(root, 'src/renderer/src'),
      '@resources': resolve(root, '../../resources'),
      '@transport': resolve(root, 'test/support/transport.stub.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [resolve(root, '../..')] },
  },
};
const server = await createServer(config);
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  for (const width of [390, 1180]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        reducedMotion: 'reduce',
        colorScheme: theme === 'light' ? 'dark' : 'light',
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(
        ({ theme }) => {
          localStorage.setItem('weq.theme-preference', theme);
          localStorage.setItem('weq.theme-accent', '#198754');
        },
        { theme },
      );
      let release;
      const delayed = new Promise((resolvePromise) => {
        release = resolvePromise;
      });
      await page.route('**/startup-flow.tsx', async (route) => {
        await delayed;
        await route.continue();
      });
      await page.goto(url, { waitUntil: 'commit' });
      const track = page.locator('[role="progressbar"]');
      await track.waitFor({ state: 'visible' });
      await page.locator('.weq-warmup-logo').evaluate(async (node) => {
        const image = new Image();
        image.src = getComputedStyle(node).backgroundImage.slice(5, -2);
        await image.decode();
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.theme),
        theme,
        '业务模块加载前尊重显式主题，不受系统相反主题影响',
      );
      await page.waitForFunction(
        () => performance.getEntriesByName('first-contentful-paint').length > 0,
      );
      assert.equal(
        await page.evaluate(() => Boolean(window.startupFlow)),
        false,
        '真实首次绘制早于延迟的业务模块',
      );
      const initial = await page.locator('.weq-warmup-logo').boundingBox();
      if (process.env.WEQ_STARTUP_ARTIFACTS) {
        await mkdir(process.env.WEQ_STARTUP_ARTIFACTS, { recursive: true });
        await page.screenshot({
          path: resolve(process.env.WEQ_STARTUP_ARTIFACTS, `initial-${width}-${theme}.png`),
        });
      }
      release();
      await page.waitForFunction(() => Boolean(window.startupFlow));
      for (const stage of ['restore', 'open', 'warmup', 'workspace']) {
        await page.evaluate((stage) => window.startupFlow.step(stage), stage);
        await page.waitForFunction(
          (stage) =>
            document
              .querySelector('.weq-warmup-status')
              ?.textContent.includes(
                { restore: '恢复', open: '打开', warmup: '准备', workspace: '加载会话' }[stage],
              ),
          stage,
        );
        assert.equal(await track.isVisible(), true);
        assert.equal(
          await track.getAttribute('aria-valuenow'),
          String({ restore: 10, open: 35, warmup: 80, workspace: 80 }[stage]),
          '全流程共享固定阶段百分比，局部预热完成不提前到 100%',
        );
        assert.equal(await page.evaluate(() => window.startupFlow.ready), false);
        const logo = await page.locator('.weq-warmup-logo').boundingBox();
        assert(
          Math.abs(logo.x - initial.x) <= 1 && Math.abs(logo.y - initial.y) <= 1,
          '阶段交接不移动 Logo',
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
      }
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const bar = page.locator('.weq-warmup-bar');
      assert.equal(
        await bar.evaluate((node) =>
          Math.round(
            (node.getBoundingClientRect().width /
              node.parentElement.getBoundingClientRect().width) *
              100,
          ),
        ),
        80,
      );
      if (process.env.WEQ_STARTUP_ARTIFACTS)
        await page.screenshot({
          path: resolve(process.env.WEQ_STARTUP_ARTIFACTS, `workspace-${width}-${theme}.png`),
        });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await bar.evaluate((node) => node.getAnimations().length), 0);
      await page.evaluate(() => window.startupFlow.finish());
      await page.waitForFunction(() => window.startupFlow.ready);
      await page.waitForFunction(() => !window.startupFlow.progress.getState().active);
      assert.equal(await track.count(), 0, '工作区真实提交并绘制后不残留启动画面');
      assert.equal(await page.getByRole('button', { name: '合成工作区已就绪' }).isVisible(), true);
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  if (process.env.WEQ_STARTUP_ELECTRON === '1') {
    const temp = await mkdtemp(resolve(root, 'node_modules/.weq-startup-'));
    try {
      await buildVite({
        ...config,
        base: './',
        build: {
          outDir: resolve(temp, 'renderer'),
          emptyOutDir: true,
          rollupOptions: { input: resolve(root, 'src/renderer/index.html') },
        },
      });
      const builtHtml = await readFile(resolve(temp, 'renderer/index.html'), 'utf8');
      assert(
        builtHtml.includes('src="./startup-theme.js"'),
        '生产入口使用可由 file:// 加载的主题脚本路径',
      );
      await readFile(resolve(temp, 'renderer/startup-theme.js'));
      await build({
        stdin: {
          contents:
            "export * from './src/main/startup_window'; export * from './src/main/window_layout';",
          resolveDir: root,
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: resolve(temp, 'helpers.mjs'),
      });
      const { default: electron } = await import('electron');
      const env = {
        ...process.env,
        WEQ_STARTUP_TEMP: temp,
        WEQ_STARTUP_ORIGIN: url.slice(0, -1),
        WEQ_STARTUP_HTML: resolve(temp, 'renderer/index.html'),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = await promisify(execFile)(
        electron,
        [resolve(root, 'test/electron/startup.cjs')],
        { env, timeout: 30000 },
      );
      assert.deepEqual(JSON.parse(await readFile(resolve(temp, 'receipt.json'), 'utf8')), {
        cases: 2,
        pixels: true,
        stableBounds: true,
        hiddenAutostart: true,
      });
      console.log(result.stdout);
      if (result.stderr) console.log(result.stderr);
      console.log('PASS: Electron 实测回执已核验（首帧非空、尺寸稳定、隐藏自启）。');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  console.log(
    'PASS: 实际入口 HTML 在业务模块延迟时已绘制，深浅主题/窄屏、恢复/打开/预热/懒加载共享阶段百分比、真实工作区绘制后 100% 并移除进度条。',
  );
} finally {
  await browser?.close();
  await server.close();
}
