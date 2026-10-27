import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  cacheDir: resolve(root, 'node_modules/.vite-clone-task-log'),
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: {
    entries: ['test/browser/clone-task-log.html'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
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
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_STYLE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [theme, width, accent, background] of [
    ['light', 1280, '#125a39', 'plain'],
    ['dark', 1280, '#ffef91', 'grid'],
    ['light', 390, '#6f4a91', 'paper'],
    ['dark', 390, '#70dbca', 'dots'],
    ['system', 390, '#ffef91', 'grid'],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({
      colorScheme: theme === 'system' ? 'dark' : theme,
      reducedMotion: 'reduce',
    });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/clone-task-log.html`,
    );
    await page.getByRole('radiogroup', { name: '模型请求' }).waitFor();
    await page.evaluate(
      ([theme, accent, background]) => {
        window.cloneLogTheme(theme, accent, background);
      },
      [theme, accent, background],
    );
    await page.getByRole('radio').nth(1).click();
    await page.getByRole('alert').filter({ hasText: '合成模型请求超时' }).waitFor();
    await page.getByText('推理输出', { exact: true }).click();
    await page.getByText('合成推理片段', { exact: true }).waitFor();
    await page.getByRole('radio').nth(1).press('ArrowRight');
    if ((await page.getByRole('radio').nth(2).getAttribute('aria-checked')) !== 'true')
      throw new Error('键盘切换失败');
    const fit = await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        [...document.querySelectorAll('.weq-clone-task-log pre, [role="radio"]')].every((node) => {
          const r = node.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth;
        }),
    );
    if (!fit) throw new Error(`布局溢出：${theme}/${width}`);
    if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('克隆任务日志：5 组主题、主题色、背景及视口检查通过，分段点击和键盘切换通过。');
} finally {
  await browser?.close();
  await server.close();
}
