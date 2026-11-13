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
  cacheDir: resolve(root, 'node_modules/.vite-storage-management'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/storage-management.stub.ts'),
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
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/storage-management.html`,
  );
  await page.waitForSelector('[data-cleanup] .weq-storage-category');
  const output = process.env.WEQ_STORAGE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const failures = [];
  let cases = 0;
  for (const width of [1280, 390, 320])
    for (const theme of ['light', 'dark', 'system'])
      for (const background of ['plain', 'telegram'])
        for (const componentStyle of ['qqnt', 'classic', 'minimal', 'retro']) {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
          await page.evaluate(
            ({ theme, background, componentStyle }) => {
              const store = window.storageQa.getState();
              store.setPreference(theme);
              store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
              store.setBackground(background);
              store.setComponentStyle(componentStyle);
            },
            { theme, background, componentStyle },
          );
          await page.waitForFunction(
            (resolved) => document.documentElement.dataset.theme === resolved,
            theme === 'light' ? 'light' : 'dark',
          );
          await page.locator('details').evaluateAll((nodes) =>
            nodes.forEach((node) => {
              node.open = true;
            }),
          );
          const checks = await page.evaluate(() => {
            const cleanup = document.querySelector('[data-cleanup]');
            const list = cleanup.querySelector('.weq-set-cache-list');
            const button = list.nextElementSibling.querySelector('button');
            const rect = button.getBoundingClientRect();
            return {
              backupFirst: cleanup
                .querySelector('.weq-storage-category summary')
                .textContent.includes('历史数据库备份'),
              bottom:
                rect.top >= list.getBoundingClientRect().bottom &&
                button.textContent.trim() === '开始清理',
              configMoved:
                !cleanup.textContent.includes('账号与应用配置') &&
                !document
                  .querySelector('[data-backup]')
                  .textContent.includes('清除账号与应用配置') &&
                !document.querySelector('[data-backup]').textContent.includes('重置全局配置') &&
                !document.querySelector('[data-backup] .weq-set-cache-list') &&
                !document.querySelector('[data-backup]').textContent.includes('本页占用'),
              merged:
                [...cleanup.querySelectorAll('[role="checkbox"]')].filter((node) =>
                  node.textContent.includes('桌面运行缓存'),
                ).length === 1,
              dataOnly: !['默认保存目录', '默认保存方式', '缓存目录', '防撤回配置'].some((label) =>
                cleanup.textContent.includes(label),
              ),
              emptyHidden: !cleanup.textContent.includes('空项目'),
              noOverflow: document.documentElement.scrollWidth <= innerWidth,
              textBounded: [...document.querySelectorAll('.weq-storage-detail')].every(
                (node) => node.scrollWidth <= node.clientWidth + 1,
              ),
              buttonsBounded: [...document.querySelectorAll('.weq-set-btn')].every(
                (node) => node.getBoundingClientRect().right <= innerWidth,
              ),
              labelsInline: [...cleanup.querySelectorAll('.weq-set-chk-label')].every((node) => {
                const icon = node.querySelector('svg').getBoundingClientRect();
                const text = node.lastElementChild.getBoundingClientRect();
                return (
                  icon.right <= text.left + 1 && icon.top < text.bottom && text.top < icon.bottom
                );
              }),
              readonlyRows: [...cleanup.querySelectorAll('.is-readonly')].every((node) => {
                const style = getComputedStyle(node);
                return (
                  node.classList.contains('weq-storage-item') &&
                  style.borderLeftWidth === '0px' &&
                  style.borderRadius === '0px'
                );
              }),
              consistentHeads: [...cleanup.querySelectorAll('.weq-storage-item-head')].every(
                (node) => {
                  const label = node.firstElementChild.getBoundingClientRect();
                  const size = node.lastElementChild.getBoundingClientRect();
                  return (
                    label.right <= size.left + 1 && size.top >= label.top && size.top < label.bottom
                  );
                },
              ),
              bareChoices: [...cleanup.querySelectorAll('[role="checkbox"]')].every(
                (node) => getComputedStyle(node).borderTopWidth === '0px',
              ),
            };
          });
          for (const [name, passed] of Object.entries(checks))
            if (!passed)
              failures.push(`${width}/${theme}/${background}/${componentStyle}: ${name}`);
          const choice = page.locator('[data-cache-id="logs"] [role="checkbox"]');
          await choice.scrollIntoViewIfNeeded();
          await choice.click();
          await choice.hover();
          await choice.focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
          const choiceState = await choice.evaluate((node) => {
            const style = getComputedStyle(node);
            return (
              node.getAttribute('aria-checked') === 'true' &&
              node === document.activeElement &&
              style.outlineStyle === 'solid' &&
              style.borderTopWidth === '0px' &&
              style.borderRadius === '0px' &&
              style.boxShadow === 'none' &&
              style.backgroundColor === 'rgba(0, 0, 0, 0)'
            );
          });
          if (!choiceState)
            failures.push(`${width}/${theme}/${background}/${componentStyle}: choiceState`);
          await page.keyboard.press('Space');
          if ((await choice.getAttribute('aria-checked')) !== 'false')
            failures.push(`${width}/${theme}/${background}/${componentStyle}: keyboardToggle`);
          await choice.evaluate((node) => {
            node.disabled = true;
          });
          const disabledBare = await choice.evaluate(
            (node) =>
              getComputedStyle(node).borderTopWidth === '0px' &&
              getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)',
          );
          if (!disabledBare)
            failures.push(`${width}/${theme}/${background}/${componentStyle}: disabledBare`);
          await choice.evaluate((node) => {
            node.disabled = false;
            node.blur();
          });
          await page.mouse.move(0, 0);
          if (
            output &&
            background === 'telegram' &&
            theme !== 'system' &&
            componentStyle === 'qqnt'
          )
            await page.screenshot({
              path: resolve(output, `${theme}-${width}.png`),
              fullPage: true,
            });
          cases++;
        }
  console.log(JSON.stringify({ cases, failures, errors }, null, 2));
  if (failures.length || errors.length) throw new Error([...failures, ...errors].join('\n'));
} finally {
  await browser?.close();
  await server.close();
}
