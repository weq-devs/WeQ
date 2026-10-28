import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cache = await mkdtemp(resolve(root, 'node_modules/.cache/extra-export-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: cache,
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/extra-export.stub.ts'),
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
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const output = process.env.WEQ_EXTRA_EXPORT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [width, theme, accent, background] of [
    [1280, 'light', '#14652d', 'plain'],
    [1280, 'dark', '#ffe8a6', 'grid'],
    [390, 'light', '#d73758', 'paper'],
    [390, 'dark', '#72c9bf', 'telegram'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/extra-export.html`,
    );
    await page.evaluate(
      ({ theme, accent, background }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.background = background;
        document.documentElement.style.setProperty('--weq-accent-effective', accent);
      },
      { theme, accent, background },
    );
    for (const kind of ['analytics', 'bot', 'album']) {
      await page.getByRole('button', { name: kind, exact: true }).click();
      if (kind === 'analytics') await page.getByRole('button', { name: /合成群聊/ }).waitFor();
      if (kind === 'bot') {
        await page.getByRole('button', { name: /合成克隆/ }).click();
        await page.getByPlaceholder('机器人登录的 QQ 号').fill('10001');
      }
      if (kind === 'album') {
        const content = page.locator('fieldset[aria-label="空间导出内容"]');
        if (
          JSON.stringify(await content.getByRole('tab').allTextContents()) !==
          JSON.stringify(['空间', '都导出', '相册'])
        )
          throw new Error('空间内容分段顺序错误');
        await content.getByRole('tab', { name: '相册', exact: true }).click();
        if (!(await page.getByRole('switch', { name: '评论与点赞', exact: true }).isDisabled()))
          throw new Error('相册单独导出不应启用说说互动');
        await content.getByRole('tab', { name: '都导出', exact: true }).click();
      }
      await page.waitForTimeout(150);
      const fitting = await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          [...document.querySelectorAll('input,button')]
            .filter((node) => node.getClientRects().length)
            .every((node) => {
              const r = node.getBoundingClientRect();
              return r.left >= 0 && r.right <= innerWidth + 1;
            }),
      );
      if (!fitting) throw new Error(`布局越界：${kind}/${theme}/${width}`);
      if (output)
        await page.screenshot({
          path: resolve(output, `${kind}-${theme}-${width}.png`),
          fullPage: true,
        });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('分析工具及两种导出入口 × 四种主题、宽度、主题色和背景组合通过。');
} finally {
  await browser?.close();
  await server.close();
  await rm(cache, { recursive: true, force: true });
}
