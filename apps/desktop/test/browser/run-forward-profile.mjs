import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-forward-profile'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/contact-card.stub.ts'),
      },
      {
        find: /^.*\/hooks\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/contact-card.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const avatar = await readFile(resolve(root, '../../resources/qqlevel/penguin.png'));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname.endsWith('qlogo.cn'))
      return route.fulfill({ contentType: 'image/png', body: avatar });
    return route.abort();
  });
  const output = process.env.WEQ_FORWARD_PROFILE_QA;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180])
    for (const theme of ['light', 'dark'])
      for (const long of [false, true]) {
        const capture = `${width}-${theme}${long ? '-long' : ''}`;
        await page.setViewportSize({ width, height: 844 });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/forward-profile.html${long ? '?long' : ''}`,
        );
        const forward = page.getByRole('dialog', { name: '合并聊天记录', exact: true });
        await forward.locator('.weq-forward-author').first().waitFor();
        await page.evaluate((theme) => {
          const store = window.forwardProfileQa.getState();
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#287b53' : '#f4e188');
          store.setBackground(theme === 'light' ? 'paper' : 'dots');
        }, theme);
        const scroll = forward.locator('.weq-forward-body');
        const scrollTop = await scroll.evaluate((element) => element.scrollTop);
        const author = forward.locator('.weq-forward-author').first();
        const layout = await author.evaluate((element) => {
          const avatar = element.querySelector('.weq-forward-avatar').getBoundingClientRect();
          const name = element.querySelector('.weq-forward-row-name').getBoundingClientRect();
          const time = element.querySelector('time').getBoundingClientRect();
          const meta = element.querySelector('.weq-forward-row-meta').getBoundingClientRect();
          const body = element.nextElementSibling.getBoundingClientRect();
          return {
            centerOffset: Math.abs(avatar.y + avatar.height / 2 - meta.y - meta.height / 2),
            nameLeft: name.x,
            timeLeft: time.x,
            nameBottom: name.bottom,
            timeTop: time.y,
            metaBottom: meta.bottom,
            bodyTop: body.y,
            bodyLeft: body.x,
            right: element.getBoundingClientRect().right,
            nameAlignment: getComputedStyle(element.querySelector('.weq-forward-row-name'))
              .textAlign,
            timeIsInteractive: Boolean(element.querySelector('time').closest('button')),
          };
        });
        assert(layout.centerOffset < 1, '头像应与昵称和时间整体居中');
        assert.equal(layout.nameLeft, layout.timeLeft, '昵称与时间必须左对齐');
        assert.equal(layout.nameLeft, layout.bodyLeft, '正文应与昵称和时间左对齐');
        assert(layout.timeTop >= layout.nameBottom, '时间必须单独显示在昵称下方');
        assert(layout.bodyTop > layout.metaBottom, '正文不能挤占身份区');
        assert(layout.right <= width, '长昵称不能撑出窗口');
        assert.equal(layout.nameAlignment, 'left', '长昵称换行后仍须保持左对齐');
        assert.equal(layout.timeIsInteractive, false);
        await author.locator('time').click();
        assert.equal(await page.getByRole('dialog', { name: '用户资料', exact: true }).count(), 0);
        if (output) await page.screenshot({ path: resolve(output, `${capture}-forward.png`) });
        for (const selector of ['.weq-forward-avatar', '.weq-forward-row-name']) {
          await author.locator(selector).click();
          const card = page.getByRole('dialog', { name: '用户资料', exact: true });
          await card.waitFor();
          assert((await card.textContent()).includes('10002'));
          const visible = await card.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const target = document.elementFromPoint(box.x + box.width / 2, box.y + 20);
            return target && element.contains(target) && box.x >= 0 && box.right <= innerWidth;
          });
          assert(visible, '名片必须位于转发窗口上方且没有超出屏幕');
          if (output)
            await page.screenshot({
              path: resolve(output, `${capture}-${selector.slice(1)}.png`),
            });
          await card.getByRole('button', { name: '关闭', exact: true }).click();
          await card.waitFor({ state: 'detached' });
          assert.equal(await scroll.evaluate((element) => element.scrollTop), scrollTop);
          cases++;
        }
        await forward.getByRole('button', { name: '查看 只有 QQ 号的好友 的名片' }).last().focus();
        await page.keyboard.press('Enter');
        const card = page.getByRole('dialog', { name: '用户资料', exact: true });
        await card.waitFor();
        assert((await card.textContent()).includes('10002'));
        await page.keyboard.press('Escape');
        await card.waitFor({ state: 'detached' });
        assert.equal(
          await forward.locator('.weq-forward-author').last().locator('button').count(),
          0,
        );
        await forward.getByTitle('查看合并转发', { exact: true }).click();
        const child = page.getByRole('dialog', { name: '嵌套聊天记录', exact: true });
        await child.locator('.weq-forward-row-name').click();
        await card.waitFor();
        assert((await card.textContent()).includes('10002'));
        await card.getByRole('button', { name: '关闭', exact: true }).click();
        await child.getByRole('button', { name: '关闭', exact: true }).click();
        assert.equal(await forward.count(), 1);
        cases += 2;
      }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, data: 'synthetic-only' }));
} finally {
  await browser?.close();
  await server.close();
}
