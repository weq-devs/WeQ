import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/composer-actions-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  optimizeDeps: { entries: ['test/browser/timeline.html'] },
  plugins: [react(), tailwind()],
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
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [resolve(root, '../..')] },
  },
});
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const output = process.env.WEQ_COMPOSER_ARTIFACTS;
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/_asset/')) {
      const resources = resolve(root, '../../resources');
      const path = resolve(resources, decodeURIComponent(url.pathname.slice('/_asset/'.length)));
      if (!path.startsWith(`${resources}/`)) return route.abort();
      try {
        return await route.fulfill({ path });
      } catch {
        return route.abort();
      }
    }
    return url.hostname === '127.0.0.1' || url.protocol === 'data:'
      ? route.continue()
      : route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html`,
  );
  await page.waitForSelector('.composer-tools');
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const [theme, width, height, background, accent] of [
    ['light', 1280, 900, 'plain', '#15764a'],
    ['dark', 1280, 900, 'grid', '#ebbd51'],
    ['light', 390, 844, 'paper', '#b53358'],
    ['dark', 390, 844, 'dots', '#73cab8'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(
      ({ theme, background, accent }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.background = background;
        document.documentElement.style.setProperty('--weq-accent-effective', accent);
      },
      { theme, background, accent },
    );
    await page.locator('.composer-tools button[title="表情"]').click();
    assert(
      (await page.getByRole('menuitem').allTextContents()).join(',') === '表情,弹射表情,互动表情',
      'Emoji menu mismatch',
    );
    if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-emoji.png`) });
    await page.getByRole('menuitem', { name: '互动表情', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '互动表情', exact: true });
    await panel.waitFor();
    await page.waitForFunction(() => {
      const panel = document.querySelector('.poke-panel');
      return (
        panel &&
        getComputedStyle(panel).opacity === '1' &&
        [...panel.querySelectorAll('img')].every(
          (image) => image.complete && image.naturalWidth > 0,
        )
      );
    });
    const box = await panel.boundingBox();
    assert(
      box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0,
      'Interactive panel outside viewport',
    );
    assert(
      await panel.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
      'Interactive panel clipped or occluded',
    );
    if (output)
      await page.screenshot({ path: resolve(output, `${theme}-${width}-interactive.png`) });
    await page.keyboard.press('Escape');
    if (width > 760) {
      await page.locator('.composer-tools button[title="语音"]').click();
      await page.getByRole('menuitem', { name: '文字转语音', exact: true }).click();
      await page.locator('.ai-voice-panel').waitFor();
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('.ai-voice-panel')).opacity === '1',
      );
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-voice.png`) });
      await page.keyboard.press('Escape');
      await page.locator('.composer-tools button[title="发送图片或文件"]').click();
      assert(
        (await page.getByRole('menuitem').allTextContents()).join(',') ===
          '发送图片,发送文件,QQ闪传',
        'File menu mismatch',
      );
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-files.png`) });
      await page.getByRole('menuitem', { name: 'QQ闪传', exact: true }).click();
      await page.locator('.flash-composer').waitFor();
      await page.keyboard.press('Escape');
    }
    results.push({ theme, width, background, accent });
  }
  assert(errors.length === 0, errors.join('\n'));
  console.log(JSON.stringify({ results, errors }));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
