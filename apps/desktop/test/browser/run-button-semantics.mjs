import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-button-semantics'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/button-semantics.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});

function luminance(color) {
  const rgb = color
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number)
    .map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
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
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const output = process.env.WEQ_BUTTON_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/button-semantics.html`,
  );
  const save = page.getByTestId('save');
  await save.waitFor();
  const settle = () =>
    page.evaluate(async () => {
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
  const styles = (locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const rgb = (color) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const data = context.getImageData(0, 0, 1, 1).data;
        return `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
      };
      return {
        background: rgb(style.backgroundColor),
        color: rgb(style.color),
        alpha: style.backgroundColor,
        border: rgb(style.borderBottomColor),
      };
    });
  let cases = 0;
  for (const width of [390, 1180]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const theme of ['light', 'dark']) {
      for (const skin of ['classic', 'retro', 'qqnt']) {
        const neutrals = [];
        for (const accent of ['#075c30', '#fff3a1']) {
          await page.evaluate(
            ({ theme, skin, accent }) => {
              const store = window.buttonTheme.getState();
              store.setPreference(theme);
              store.setComponentStyle(skin);
              store.setAccent(accent);
              store.setBackground(theme === 'light' ? 'grid' : 'telegram');
            },
            { theme, skin, accent },
          );
          await settle();
          const label = `${width}/${theme}/${skin}/${accent}`;
          const cancel = await styles(page.getByTestId('cancel'));
          const retry = await styles(page.getByTestId('retry'));
          const primary = await styles(save);
          const disabled = await styles(page.getByTestId('disabled'));
          assert.deepEqual(retry, cancel, `${label}: 普通按钮默认中性，与旧 soft 用法一致`);
          for (const name of ['打开数据库浏览', '通知设置', '打开修复工具']) {
            const entry = await styles(page.getByRole('button', { name, exact: true }));
            assert.deepEqual(entry, cancel, `${label}: ${name}应为中性入口`);
          }
          assert.notDeepEqual(primary, cancel, `${label}: 主动作与普通入口有明确区分`);
          assert.notDeepEqual(disabled, primary, `${label}: 禁用主动作不保留强调`);
          const danger = await styles(page.getByTestId('danger-solid'));
          assert.notDeepEqual(danger, primary, `${label}: 危险操作独立于主题主动作`);
          assert(contrast(primary.background, primary.color) >= 4.5, `${label}: 主动作文字对比度`);
          neutrals.push({ background: cancel.background, color: cancel.color, danger });
          await save.click();
          await page.getByRole('button', { name: '已保存', exact: true }).waitFor();
          await page.getByTestId('cancel').click();
          assert.equal(await save.textContent(), '保存设置');
          const toggle = page.getByRole('switch', { name: '包含媒体', exact: true });
          assert.equal(await toggle.getAttribute('aria-checked'), 'true');
          await toggle.click();
          assert.equal(await toggle.getAttribute('aria-checked'), 'false');
          await toggle.click();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
            `${label}: 不横向溢出`,
          );
          await page.getByTestId('retry').focus();
          await page.keyboard.press('Tab');
          const focus = await page.getByTestId('cancel').evaluate((element) => ({
            active: element === document.activeElement,
            outline: getComputedStyle(element).outlineStyle,
          }));
          assert(focus.active && focus.outline !== 'none', `${label}: 中性按钮保留键盘焦点`);
          const beforeHover = await styles(page.getByTestId('retry'));
          await page.getByTestId('retry').hover();
          await settle();
          const hovered = await styles(page.getByTestId('retry'));
          assert.notDeepEqual(hovered, primary, `${label}: 悬停不升级为主题色主动作`);
          assert.equal(hovered.color, beforeHover.color, `${label}: 悬停保持中性文字`);
          await page.mouse.move(0, 0);
          if (output && accent === '#075c30') {
            await page.evaluate(() => {
              document.activeElement?.blur();
              scrollTo(0, 0);
            });
            await page.screenshot({
              path: resolve(output, `${width}-${theme}-${skin}.png`),
              fullPage: true,
            });
          }
          cases++;
        }
        assert.deepEqual(
          neutrals[0],
          neutrals[1],
          `${width}/${theme}/${skin}: 中性与危险按钮不随主题色变色`,
        );
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
