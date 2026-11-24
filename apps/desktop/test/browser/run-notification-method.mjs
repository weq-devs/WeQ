import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, webkit } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-notification-method'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/notification-settings.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
const errors = [];
const engines = (process.env.WEQ_NOTIFICATION_ENGINES ?? 'chromium,webkit').split(',');
let cases = 0;
try {
  await server.listen();
  const output = process.env.WEQ_NOTIFICATION_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [engine, runner] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    if (!engines.includes(engine)) continue;
    const executablePath =
      engine === 'chromium'
        ? process.env.WEQ_BROWSER_EXECUTABLE
        : process.env.WEQ_WEBKIT_EXECUTABLE;
    browser = await runner.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage({ reducedMotion: 'reduce', hasTouch: true });
    page.setDefaultNavigationTimeout(120000);
    await page.addInitScript(() => localStorage.clear());
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ||
      route.request().url().startsWith('data:')
        ? route.continue()
        : route.abort(),
    );
    for (const [width, height] of [
      [320, 740],
      [390, 844],
      [844, 390],
      [1280, 900],
    ]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/notification-settings.html`,
        );
        await page.evaluate((theme) => {
          const store = window.notificationTheme.getState();
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#b5243e' : '#81c995');
          store.setBackground(theme === 'light' ? 'grid' : 'telegram');
        }, theme);
        const method = page.getByRole('combobox', { name: '新邮件通知方式', exact: true });
        await method.waitFor();
        assert.equal(await method.inputValue(), 'both');
        assert.equal(await method.locator('option').count(), 4);
        const box = await method.boundingBox();
        assert(box.width > 180 && box.width <= 224, JSON.stringify(box));
        assert(box.height >= 44, JSON.stringify(box));
        for (const [value, channels] of [
          ['banner', { banner: true, system: false }],
          ['off', { banner: false, system: false }],
          ['system', { banner: false, system: true }],
          ['both', { banner: true, system: true }],
        ]) {
          await method.selectOption(value);
          await page.waitForFunction(
            ({ channels }) => {
              const state = window.notificationFixture.settings.notificationEvents.mail;
              return state.banner === channels.banner && state.system === channels.system;
            },
            { channels },
          );
          assert.equal(await method.inputValue(), value);
        }
        const updates = await page.evaluate(() =>
          window.notificationFixture.calls.filter(
            (call) => call.path === 'bootstrap.setNotificationEvents',
          ),
        );
        assert.equal(updates.length, 4);
        assert(updates.every((call) => Object.keys(call.input.channels).length === 2));
        assert.equal(await page.getByRole('heading', { name: 'QQ 邮箱', exact: true }).count(), 1);
        assert.equal(
          await page.getByRole('button', { name: '邮件通知设置', exact: true }).count(),
          0,
        );
        if (await page.evaluate(() => typeof Notification !== 'undefined')) {
          await method.selectOption('banner');
          await page.evaluate(() => {
            const original = Notification.requestPermission;
            window.notificationRestorePermission = () => {
              Notification.requestPermission = original;
            };
            Notification.requestPermission = () =>
              new Promise((resolve) => {
                window.notificationResolvePermission = resolve;
              });
          });
          await method.selectOption('system');
          await page.waitForFunction(
            () =>
              window.notificationResolvePermission &&
              !document.querySelector('[aria-label="新邮件通知方式"]').disabled,
          );
          await method.selectOption('off');
          await page.evaluate(() => {
            window.notificationResolvePermission('denied');
            window.notificationRestorePermission();
          });
          assert.equal(await method.inputValue(), 'off');
          assert.equal(await page.locator('.weq-notification-method [role="alert"]').count(), 0);
          await method.selectOption('both');
        }
        const overflow = await page.evaluate(() => ({
          document: document.documentElement.scrollWidth > innerWidth,
          rows: [...document.querySelectorAll('.weq-set-row')]
            .filter((row) => {
              const main = row.querySelector('.weq-set-row-main')?.getBoundingClientRect();
              const control = row.querySelector('.weq-set-row-ctrl')?.getBoundingClientRect();
              return (
                main &&
                control &&
                main.top < control.bottom &&
                control.top < main.bottom &&
                main.right > control.left + 1
              );
            })
            .map((row) => row.textContent),
        }));
        assert.deepEqual(overflow, { document: false, rows: [] });
        if (output)
          await page.screenshot({ path: resolve(output, `${engine}-${width}-${theme}.png`) });
        await page.getByRole('button', { name: '邮箱红点设置', exact: true }).click();
        await page.getByRole('button', { name: '其他动态', exact: true }).click();
        const banner = page.getByRole('switch', { name: '新邮件：应用内横幅通知', exact: true });
        assert.equal(await banner.getAttribute('aria-checked'), 'true');
        await banner.click();
        const back = page.getByRole('button', { name: '返回设置', exact: true });
        if (await back.isVisible()) await back.click();
        await page.getByRole('button', { name: 'QQ 邮箱', exact: true }).click();
        assert.equal(await method.inputValue(), 'system');
        cases++;
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/notification-settings.html?surface=damage`,
        );
        await page.evaluate((theme) => {
          const store = window.notificationTheme.getState();
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#b5243e' : '#81c995');
        }, theme);
        const damage = page.getByRole('combobox', { name: '数据库异常提醒通知方式', exact: true });
        await damage.selectOption('off');
        await page.waitForFunction(
          () => !window.notificationFixture.settings.notificationEvents.databaseDamage.banner,
        );
        assert.equal(await page.evaluate(() => window.notificationDialogState.closes), 0);
        const footer = await page.locator('.weq-db-damaged-foot').evaluate((node) => ({
          overflow: node.scrollWidth > node.clientWidth,
          children: [...node.children].map((child) => {
            const rect = child.getBoundingClientRect();
            return { left: rect.left, right: rect.right };
          }),
        }));
        assert.equal(footer.overflow, false, JSON.stringify(footer));
        assert(
          footer.children.every((rect) => rect.left >= 0 && rect.right <= width),
          JSON.stringify(footer),
        );
        if (output)
          await page.screenshot({
            path: resolve(output, `${engine}-${width}-${theme}-damage.png`),
          });
        cases++;
      }
    }
    await browser.close();
    browser = undefined;
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, engines, errors }));
} finally {
  await browser?.close();
  await server.close();
}
