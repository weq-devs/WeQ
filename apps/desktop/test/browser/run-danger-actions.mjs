import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_DANGER_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-danger-actions'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/danger-actions.stub.ts'),
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
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/danger-actions.html`,
  );
  await page.getByRole('button', { name: '清除 WeQ 已读记录', exact: true }).waitFor();
  if (output) await mkdir(output, { recursive: true });
  const failures = [];
  let cases = 0;
  const inspect = () =>
    page.evaluate(() => {
      const paint = document.createElement('canvas').getContext('2d');
      const rgba = (color) => {
        paint.clearRect(0, 0, 1, 1);
        paint.fillStyle = color;
        paint.fillRect(0, 0, 1, 1);
        return [...paint.getImageData(0, 0, 1, 1).data];
      };
      const luminance = (rgb) =>
        rgb.slice(0, 3).reduce((sum, v, i) => {
          const c = v / 255;
          return (
            sum +
            (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]
          );
        }, 0);
      const surface = rgba(getComputedStyle(document.body).backgroundColor);
      const metrics = [
        ...document.querySelectorAll('button[data-danger]:not(:disabled),button[data-legacy]'),
      ].map((node) => {
        const style = getComputedStyle(node),
          fg = rgba(style.color),
          bg = rgba(style.backgroundColor),
          border = rgba(style.borderTopColor);
        const blended = bg
          .slice(0, 3)
          .map((v, i) => (v * bg[3]) / 255 + surface[i] * (1 - bg[3] / 255));
        const levels = [luminance(fg), luminance(blended)].sort((a, b) => b - a);
        const red = (rgb) => rgb[0] > rgb[1] * 1.3 && rgb[0] > rgb[2] * 1.15;
        return {
          label: node.textContent?.trim() || node.getAttribute('aria-label'),
          level: node.dataset.danger ?? 'outline',
          menu: Boolean(node.closest('.message-context-menu, .weq-conversation-actions-menu')),
          foreground: red(fg),
          colors: {
            foreground: style.color,
            background: style.backgroundColor,
            surface: getComputedStyle(document.body).backgroundColor,
          },
          background: red(bg) && bg[3] > 230,
          transparent: bg[3] === 0,
          border: red(border) && parseFloat(style.borderTopWidth) >= 1,
          borderless: parseFloat(style.borderTopWidth) === 0,
          contrast: (levels[0] + 0.05) / (levels[1] + 0.05),
          overflow: node.scrollWidth > node.clientWidth + 1,
          radius: style.borderTopLeftRadius,
        };
      });
      const disabledNeutral = [
        ...document.querySelectorAll('button[data-danger]:disabled:not([data-menu-disabled])'),
      ].every((node) => {
        const style = getComputedStyle(node);
        return (
          style.backgroundColor ===
            getComputedStyle(document.querySelector('[data-danger="outline"]:disabled'))
              .backgroundColor && style.cursor === 'not-allowed'
        );
      });
      return {
        metrics,
        disabledNeutral,
        disabledMenu: [...document.querySelectorAll('[data-menu-disabled]')].every((node) => {
          const style = getComputedStyle(node);
          return (
            parseFloat(style.borderTopWidth) === 0 &&
            rgba(style.backgroundColor)[3] === 0 &&
            style.cursor === 'default'
          );
        }),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark', 'system'])
      for (const style of ['classic', 'qqnt', 'minimal', 'retro'])
        for (const accent of ['#075c30', '#ffffff', '#000000']) {
          await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
          await page.evaluate(
            ({ theme, style, accent }) => {
              const s = window.dangerActionsQa.getState();
              s.setPreference(theme);
              s.setComponentStyle(style);
              s.setAccent(accent);
            },
            { theme, style, accent },
          );
          const label = `${width}/${theme}/${style}/${accent}`;
          const result = await inspect();
          for (const row of result.metrics) {
            const appearance = row.menu
              ? row.borderless && row.transparent && row.foreground
              : row.border &&
                (row.level === 'solid' ? row.background : row.foreground && !row.background);
            if (!appearance || row.overflow || row.contrast < 4.5)
              failures.push({ case: label, ...row });
            if (style === 'retro' && row.radius !== '0px')
              failures.push({ case: label, reason: '复古外观圆角被覆盖', ...row });
          }
          if (result.overflow) failures.push({ label, reason: '页面溢出' });
          if (!result.disabledNeutral) failures.push({ label, reason: '禁用状态未统一' });
          if (!result.disabledMenu) failures.push({ label, reason: '禁用菜单出现边框或底色' });
          if (output && accent === '#075c30')
            await page.screenshot({
              path: resolve(output, `${width}-${theme}-${style}-controls.png`),
            });
          await page.getByRole('button', { name: '清除 WeQ 已读记录', exact: true }).click();
          const dialog = page.getByRole('dialog');
          assert.equal(
            await dialog
              .getByRole('button', { name: '清除', exact: true })
              .getAttribute('data-danger'),
            'outline',
          );
          await dialog.getByRole('button', { name: '取消', exact: true }).click();
          await page.getByRole('button', { name: '恢复全局默认设置', exact: true }).click();
          assert.equal(
            await dialog
              .getByRole('button', { name: '确认恢复默认', exact: true })
              .getAttribute('data-danger'),
            'solid',
          );
          if (output && accent === '#075c30')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-${style}.png`) });
          await dialog.getByRole('button', { name: '取消', exact: true }).click();
          cases++;
        }
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      window.dangerActionsQa.getState().setPreference(theme);
    }, theme);
    const buttons = page.locator(
      ':is(.message-context-menu, .weq-conversation-actions-menu) button[data-danger]:not(:disabled)',
    );
    for (const button of await buttons.all()) {
      for (const state of ['hover', 'focus']) {
        if (state === 'hover') await button.hover();
        else {
          await button.focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
        }
        assert(
          await button.evaluate((node, state) => {
            const style = getComputedStyle(node);
            return (
              parseFloat(style.borderTopWidth) === 0 &&
              style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
              (state !== 'focus' || style.outlineStyle !== 'none')
            );
          }, state),
          `${theme}/${state}: 菜单保留轻量反馈及键盘焦点，不恢复边框或实底`,
        );
      }
    }
  }
  await page.getByRole('button', { name: '清除 WeQ 已读记录', exact: true }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.notEqual(
    await page
      .getByRole('button', { name: '清除 WeQ 已读记录', exact: true })
      .evaluate((node) => getComputedStyle(node).outlineStyle),
    'none',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { cases, failureCount: failures.length, failures: failures.slice(0, 10), errors },
      null,
      2,
    ),
  );
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  await server.close();
}
