import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stub = resolve(root, 'test/browser/contact-card.stub.ts');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_CONTACT_WORKSPACE_QA;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/hooks\/useQQWriteSession$/, replacement: stub },
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
const report = [];
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
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-card.html`;
  await page.goto(url);
  await page.locator('.weq-profile-expand').click();
  await page.locator('.weq-contact-workspace-v2').waitFor();
  assert.deepEqual(await page.locator('.weq-profile-directory button').allTextContents(), [
    '个人资料',
    '与我的关系',
    '群内资料',
    '个性展示',
  ]);
  assert.equal(
    (await page.evaluate(() => window.contactCardQa.calls)).some((call) =>
      call.path.includes('history.'),
    ),
    false,
  );
  await page.getByRole('button', { name: '资料变更记录', exact: true }).click();
  await page
    .getByRole('region', { name: '资料历史', exact: true })
    .locator('.contact-history-entry')
    .waitFor();
  const historyCalls = await page.evaluate(() =>
    window.contactCardQa.calls.filter((call) => call.path.endsWith('history.list')),
  );
  assert.ok(
    historyCalls.length && historyCalls.every((call) => call.input.category === 'getProfile'),
  );
  await page.getByRole('button', { name: '资料变更记录', exact: true }).click();
  await page.getByRole('button', { name: '群内资料', exact: true }).click();
  const select = page.getByLabel('群聊', { exact: true });
  await page.getByText('第一群昵称', { exact: true }).waitFor();
  await select.selectOption('10004');
  await page.getByText('第二群昵称', { exact: true }).waitFor();
  assert.equal(await page.getByText('第一群头衔', { exact: true }).isVisible(), false);
  await page.getByRole('button', { name: '本群发言', exact: true }).click();
  await page.getByText('合成本群发言', { exact: true }).waitFor();
  assert.equal(
    (
      await page.evaluate(() =>
        window.contactCardQa.calls
          .filter((call) => call.path === 'account.browseConversation')
          .at(-1),
      )
    ).input.conv,
    '10004',
  );
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.contactCardQa.profileEnabled = true;
    window.contactCardQa.notify();
  });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.classList.toggle('dark', theme === 'dark');
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#b53049' : '#72cdb5',
        );
      }, theme);
      for (const title of ['个人资料', '与我的关系', '群内资料', '个性展示']) {
        await page.getByRole(width > 720 ? 'button' : 'tab', { name: title, exact: true }).click();
        if (title === '个性展示') {
          const question = page.getByRole('button', { name: '匿问我答', exact: true });
          if ((await question.getAttribute('aria-expanded')) === 'false') await question.click();
        }
        const overflow = await page.evaluate(() => {
          const body = document.querySelector('.weq-profile-workspace-body');
          return (
            document.documentElement.scrollWidth > innerWidth || body.scrollWidth > body.clientWidth
          );
        });
        if (overflow) {
          if (output) await page.screenshot({ path: resolve(output, 'overflow.png') });
          console.log(
            await page.locator('.weq-profile-workspace-body').evaluate((body) =>
              [...body.querySelectorAll('*')]
                .filter(
                  (node) => node.getBoundingClientRect().right > body.getBoundingClientRect().right,
                )
                .map((node) => ({
                  class: node.className,
                  tag: node.tagName,
                  width: node.getBoundingClientRect().width,
                  text: node.textContent.slice(0, 60),
                })),
            ),
          );
        }
        assert.equal(overflow, false, `${width}/${theme}/${title} 不应横向溢出`);
        report.push({ width, theme, title, overflow });
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${theme}-${title}.png`) });
      }
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [title, detail] of [
      ['个人资料', '签名历史'],
      ['与我的关系', '互动画像'],
      ['个性展示', '个性装扮'],
    ]) {
      await page.getByRole(width > 720 ? 'button' : 'tab', { name: title, exact: true }).click();
      const trigger = page.getByRole('button', { name: detail, exact: true });
      if ((await trigger.getAttribute('aria-expanded')) === 'false') await trigger.click();
      const panel = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
      await panel.scrollIntoViewIfNeeded();
      if (detail === '互动画像') await page.getByRole('img', { name: '互动风格雷达' }).waitFor();
      assert.equal(
        await page
          .locator('.weq-profile-workspace-body')
          .evaluate((body) => body.scrollWidth > body.clientWidth),
        false,
        `${width}/${detail} 不应溢出`,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-expanded-${detail}.png`) });
    }
  }
  assert.deepEqual(errors, []);
  if (output)
    await writeFile(resolve(output, 'report.json'), JSON.stringify({ report, errors }, null, 2));
  console.log(JSON.stringify({ cases: report.length, errors }));
} finally {
  await browser?.close();
  await server.close();
}
