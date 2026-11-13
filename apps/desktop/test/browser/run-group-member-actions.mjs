import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stub = resolve(root, 'test/browser/contact-card.stub.ts');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_CONTACT_CARD_QA;
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
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.WEQ_BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://**', (route) => route.abort());
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-card.html`;
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('.weq-member-pop').waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty('--weq-accent-effective', '#137b55');
        window.contactCardQa.muted = true;
        window.contactCardQa.notify();
      }, theme);
      const card = page.locator('.weq-member-pop');
      await card.getByTitle('解除禁言', { exact: true }).click();
      const confirm = page.getByRole('button', { name: '解除禁言', exact: true });
      await confirm.waitFor();
      await page.waitForTimeout(300);
      if (output)
        await page.screenshot({ path: resolve(output, `member-unmute-${theme}-${width}.png`) });
      await page.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(
        await page.evaluate(
          () =>
            window.contactCardQa.calls.filter(
              (call) => call.path === 'account.qqWrite.groupMemberMute',
            ).length,
        ),
        0,
      );
      await card.getByTitle('解除禁言', { exact: true }).click();
      await confirm.click();
      await page.waitForFunction(
        () => !document.querySelector('.weq-member-pop')?.textContent?.includes('禁言截止'),
      );
      const write = await page.evaluate(() =>
        window.contactCardQa.calls.find((call) => call.path === 'account.qqWrite.groupMemberMute'),
      );
      assert.equal(write.input.duration, 0);
      for (const title of ['定位到入群时间', '定位到最后群发言']) {
        await card.getByTitle(title, { exact: true }).click();
        await card.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: '打开名片', exact: true }).click();
        await card.waitFor();
      }
      const jumps = await page.evaluate(() =>
        window.contactCardQa.calls.filter((call) => call.path === 'fixture.navigate'),
      );
      assert.deepEqual(
        jumps.map((call) => call.input.anchor.seq),
        ['51', '52'],
      );
      const bounds = await card.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      if (output)
        await page.screenshot({ path: resolve(output, `member-times-${theme}-${width}.png`) });

      await page.goto(`${url}?gray-tip`, { waitUntil: 'domcontentloaded' });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty('--weq-accent-effective', '#137b55');
        window.contactCardQa.muted = true;
        window.contactCardQa.role = 'member';
        window.contactCardQa.online = false;
        window.contactCardQa.notify();
      }, theme);
      await page.getByRole('button', { name: '查看 林同学 的名片' }).click();
      await card.waitFor();
      const groupSection = card
        .locator('.weq-profile-section-block')
        .filter({ hasText: '群内资料' });
      await groupSection.getByText('禁言截止', { exact: true }).waitFor();
      const labels = await groupSection.locator('.weq-profile-data-label').allTextContents();
      assert.ok(labels.includes('入群时间'));
      assert.ok(labels.includes('群等级'));
      assert.deepEqual(labels.slice(-2), ['最后群发言', '禁言截止']);
      assert.equal(await card.getByTitle('解除禁言', { exact: true }).count(), 0);
      const grayBounds = await card.boundingBox();
      assert.ok(grayBounds.x >= 0 && grayBounds.x + grayBounds.width <= width);
      if (output)
        await page.screenshot({ path: resolve(output, `gray-tip-member-${theme}-${width}.png`) });
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Passed: member unmute confirmation, cancel, readback, both time jumps, gray-tip automatic member details and mute ordering; light/dark at 1280/390px.',
  );
} finally {
  await browser?.close();
  await server.close();
}
