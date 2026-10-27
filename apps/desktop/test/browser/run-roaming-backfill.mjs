import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  cacheDir: resolve(root, 'node_modules/.vite-roaming-backfill'),
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/roaming-backfill.stub.ts'),
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
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  for (const [dark, width, accent, background] of [
    [false, 1000, '#075c30', 'paper'],
    [true, 1000, '#fff3a1', 'grid'],
    [false, 360, '#006c83', 'dots'],
    [true, 360, '#73cab8', 'telegram'],
  ]) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: dark ? 'dark' : 'light' });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/roaming-backfill.html${width === 360 ? '?single&system' : ''}`,
    );
    await page.evaluate(
      ([dark, accent, background]) => window.roamingTheme(dark, accent, background),
      [dark, accent, background],
    );
    await page.getByRole('button', { name: '开始拉取', exact: true }).waitFor();
    const theme = await page.locator('html').getAttribute('data-theme');
    if (theme !== (dark ? 'dark' : 'light')) throw new Error('主题或跟随系统未生效');
    if (await page.locator('.weq-roaming-jobs').count()) throw new Error('配置页重复展示任务');
    if (
      await page
        .getByLabel('补全范围')
        .innerText()
        .then((text) => text.includes('SSO'))
    )
      throw new Error('配置页泄漏技术参数');
    await page.getByText('高级设置', { exact: true }).click();
    await page.getByRole('spinbutton').fill('800');
    await page.getByRole('checkbox', { name: '尝试找回更早的聊天记录' }).check();
    await page.getByRole('button', { name: '近 7 天', exact: true }).click();
    await page.getByText('高级设置', { exact: true }).click();
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('button,summary,input,select')].some((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          (rect.left < 0 ||
            rect.right > innerWidth + 1 ||
            element.scrollWidth > element.clientWidth + 1)
        );
      }),
    );
    if (overflow) throw new Error(`控件溢出: ${dark}/${width}`);
    if (output)
      await page.screenshot({
        path: resolve(output, `roaming-${dark ? 'dark' : 'light'}-${width}.png`),
      });
    await page.getByRole('button', { name: '开始拉取', exact: true }).click();
    await page.getByText('已转交当前任务', { exact: true }).waitFor();
    const input = await page.evaluate(() => window.roamingSubmissions);
    if (
      input.length !== 1 ||
      !input[0].startImmediately ||
      !input[0].beforeOldest ||
      input[0].intervalMs !== 800 ||
      input[0].targets.length !== (width === 360 ? 1 : 2) ||
      !input[0].range.start ||
      !input[0].range.end
    )
      throw new Error('提交未保留选项或未自动启动');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('漫游拉取：4 组深浅主题、主题色、背景与桌面/窄屏检查，一键提交与任务交接通过');
} finally {
  await browser?.close();
  await server.close();
}
