import assert from 'node:assert/strict';
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
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/profile-identity.stub.ts'),
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
  const errors = [];
  let cases = 0;
  for (const width of [390, 600, 800, 1180]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const theme of ['light', 'dark']) {
      let contactHeaderLayout;
      for (const kind of ['friend', 'group']) {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-identity.html?short&${kind === 'friend' ? 'friend' : 'group'}`,
        );
        const close = page.locator('.weq-profile-page-close');
        await close.waitFor();
        await page.evaluate((theme) => {
          const store = window.profileIdentityQa.store.getState();
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        }, theme);
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
        const box = await close.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0);
        const headerLayout = await page
          .locator('.weq-profile-page-header--split')
          .evaluate((element) => {
            const style = getComputedStyle(element);
            const identity = getComputedStyle(element.querySelector('.weq-contact-identity'));
            const button = getComputedStyle(element.querySelector('.weq-contact-secondary'));
            return {
              columns: style.gridTemplateColumns,
              gap: style.gap,
              padding: style.padding,
              maxHeight: style.maxHeight,
              overflow: style.overflow,
              identityAlignment: identity.alignItems,
              buttonHeight: button.height,
              buttonPadding: button.padding,
              buttonBorder: button.border,
              buttonRadius: button.borderRadius,
            };
          });
        if (kind === 'friend') contactHeaderLayout = headerLayout;
        else
          assert.deepEqual(
            headerLayout,
            contactHeaderLayout,
            `群与联系人页头布局不一致：${width}/${theme}`,
          );
        const settings = page.getByRole('button', { name: '会话设置', exact: true });
        const settingsBox = await settings.boundingBox();
        assert.ok(settingsBox && settingsBox.x + settingsBox.width <= box.x);
        await settings.click();
        const pane = page.locator('.weq-conversation-settings-pane');
        await pane.waitFor();
        assert.equal(await page.evaluate(() => window.profileIdentityQa.closes), 0);
        await pane
          .getByRole('button', {
            name: kind === 'friend' ? '查看联系人资料' : '查看群资料',
            exact: true,
          })
          .click();
        await pane.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => window.profileIdentityQa.closes), 0);
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => window.profileIdentityQa.closes), 1);
        await close.click();
        assert.equal(await page.evaluate(() => window.profileIdentityQa.closes), 2);
        // 每个布局都实际生成截图，避免只检查最终 DOM。
        await page.screenshot({
          path: process.env.WEQ_PROFILE_RETURN_QA
            ? `${process.env.WEQ_PROFILE_RETURN_QA}-${kind}-${theme}-${width}.png`
            : undefined,
        });
        cases++;
      }
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, cases }));
} finally {
  await browser?.close();
  await server.close();
}
