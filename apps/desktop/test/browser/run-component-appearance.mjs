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
  cacheDir: resolve(root, 'node_modules/.vite-component-appearance'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/component-appearance.html`;
  await page.goto(url);
  await page.waitForSelector('.conversation-row');
  const styles = await page.evaluate(() => window.appearanceQa.componentStyles);
  const output = process.env.WEQ_APPEARANCE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const failures = [];
  let cases = 0;
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 920 });
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      for (const background of ['plain', 'paper', 'grid', 'dots', 'wash', 'telegram']) {
        await page.evaluate(
          ({ theme, background }) => {
            const store = window.appearanceQa.store.getState();
            store.setPreference(theme);
            store.setBackground(background);
            const accent =
              background === 'plain'
                ? theme === 'light'
                  ? '#ffffff'
                  : '#000000'
                : background === 'dots'
                  ? theme === 'light'
                    ? '#000000'
                    : '#ffffff'
                  : background === 'grid'
                    ? '#8b5cf6'
                    : theme === 'light'
                      ? '#075c30'
                      : '#fff3a1';
            store.setAccent(accent);
          },
          { theme, background },
        );
        for (const { value, label } of styles) {
          await page.getByRole('radio', { name: label, exact: true }).click();
          for (const density of ['compact', 'comfortable']) {
            await page
              .getByRole('radio', { name: density === 'compact' ? '紧凑' : '舒适', exact: true })
              .click();
            await page.waitForTimeout(20);
            const checks = await page.evaluate(
              ({ value, density, width }) => {
                const css = (selector) => getComputedStyle(document.querySelector(selector));
                const row = document.querySelector('.conversation-row');
                const slot = row.parentElement;
                const avatar = row.querySelector('.avatar').getBoundingClientRect();
                const rowRect = row.getBoundingClientRect();
                const preview = `[data-component-preview="${value}"]`;
                const primary = css('.weq-set-btn');
                const pixel = (color) => {
                  const ctx = document.createElement('canvas').getContext('2d');
                  ctx.fillStyle = color;
                  ctx.fillRect(0, 0, 1, 1);
                  return `#${[...ctx.getImageData(0, 0, 1, 1).data]
                    .slice(0, 3)
                    .map((v) => v.toString(16).padStart(2, '0'))
                    .join('')}`;
                };
                return {
                  selected:
                    document.documentElement.dataset.componentStyle === value &&
                    document
                      .querySelector('.weq-style-option[aria-checked="true"]')
                      .getAttribute('aria-label') ===
                      window.appearanceQa.componentStyles.find((s) => s.value === value).label,
                  density: document.documentElement.dataset.density === density,
                  rowSize:
                    Math.abs(
                      row.getBoundingClientRect().height - slot.getBoundingClientRect().height,
                    ) < 1,
                  avatarFits: avatar.top >= rowRect.top && avatar.bottom <= rowRect.bottom,
                  expectedHeight:
                    row.getBoundingClientRect().height ===
                    (density === 'compact' ? (width <= 720 ? 64 : 54) : width <= 760 ? 76 : 62),
                  previewGeometry:
                    value === 'classic' ||
                    css('.weq-input').borderRadius ===
                      css(`${preview} .weq-style-preview-input`).borderRadius,
                  toggleGeometry:
                    value === 'classic' ||
                    css('.weq-set-toggle-track').borderRadius ===
                      css(`${preview} .weq-style-preview-toggle`).borderRadius,
                  primaryContrast:
                    window.appearanceQa.contrastRatio(
                      pixel(primary.color),
                      pixel(primary.backgroundColor),
                    ) >= 4.5,
                  noOverflow: document.documentElement.scrollWidth <= innerWidth,
                  previewVisible: [...document.querySelectorAll('.weq-style-preview')].every(
                    (node) =>
                      node.getBoundingClientRect().height >= 120 &&
                      node.scrollWidth <= node.clientWidth,
                  ),
                  blur:
                    value !== 'glass' ||
                    css('.weq-directory-scope-menu').backdropFilter.includes('blur'),
                  disabled: css('button:disabled').backgroundColor !== primary.backgroundColor,
                };
              },
              { value, density, width },
            );
            for (const [check, passed] of Object.entries(checks))
              if (!passed)
                failures.push(`${width}/${theme}/${background}/${value}/${density}: ${check}`);
            cases++;
          }
          if (output && width === 1280 && background === 'telegram')
            await page.screenshot({
              path: resolve(output, `${theme}-${value}.png`),
              fullPage: true,
            });
        }
      }
    }
  }
  // 键盘、实际滚动、刷新恢复与系统模式同样走真实组件。
  await page.getByRole('radio', { name: '复古', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  if (
    (await page.getByRole('radio', { name: '经典', exact: true }).getAttribute('aria-checked')) !==
    'true'
  )
    failures.push('键盘循环选择');
  await page.keyboard.press('End');
  await page.getByRole('radio', { name: '紧凑', exact: true }).click();
  await page.locator('[data-weq-windowed-list]').evaluate((node) => {
    node.scrollTop = 5000;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  const aligned = await page
    .locator('.conversation-row')
    .evaluateAll((rows) =>
      rows.every(
        (row) =>
          row.getBoundingClientRect().height === row.parentElement.getBoundingClientRect().height,
      ),
    );
  if (!aligned) failures.push('滚动后虚拟行错位');
  await page.reload();
  await page.waitForSelector('.conversation-row');
  if (
    (await page.getByRole('radio', { name: '复古', exact: true }).getAttribute('aria-checked')) !==
    'true'
  )
    failures.push('刷新风格恢复');
  if (
    (await page.getByRole('radio', { name: '紧凑', exact: true }).getAttribute('aria-checked')) !==
    'true'
  )
    failures.push('刷新密度恢复');
  await page.evaluate(() => window.appearanceQa.store.getState().setPreference('system'));
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  if (output) await page.screenshot({ path: resolve(output, 'mobile-retro.png'), fullPage: true });
  console.log(JSON.stringify({ cases, failures, errors }, null, 2));
  if (failures.length || errors.length) throw new Error([...failures, ...errors].join('\n'));
} finally {
  await browser?.close();
  await server.close();
}
