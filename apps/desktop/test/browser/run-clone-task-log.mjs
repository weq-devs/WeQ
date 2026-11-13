import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

function contrast(foreground, background) {
  const luminance = (color) => {
    const channels = color
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
    return channels.reduce((sum, channel, index) => {
      const value = channel / 255;
      return (
        sum +
        (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
          [0.2126, 0.7152, 0.0722][index]
      );
    }, 0);
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  cacheDir: resolve(root, 'node_modules/.vite-clone-task-log'),
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: {
    entries: ['test/browser/clone-task-log.html'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
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
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_STYLE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [theme, width, accent, background] of [
    ['light', 1280, '#125a39', 'plain'],
    ['dark', 1280, '#ffef91', 'grid'],
    ['light', 390, '#6f4a91', 'paper'],
    ['dark', 390, '#70dbca', 'dots'],
    ['system', 390, '#ffef91', 'grid'],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({
      colorScheme: theme === 'system' ? 'dark' : theme,
      reducedMotion: 'reduce',
    });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/clone-task-log.html`,
    );
    await page.getByRole('radiogroup', { name: '模型请求' }).waitFor();
    await page.evaluate(
      ([theme, accent, background]) => {
        window.cloneLogTheme(theme, accent, background);
      },
      [theme, accent, background],
    );
    const spinner = page.locator('.weq-long-task-state svg');
    assert.equal(await spinner.evaluate((node) => getComputedStyle(node).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const transforms = await spinner.evaluate(async (node) => {
      const before = getComputedStyle(node).transform;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return [before, getComputedStyle(node).transform];
    });
    assert.notEqual(transforms[0], transforms[1], '运行中的任务圆圈必须实际旋转');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('radio').nth(1).click();
    await page.getByRole('alert').filter({ hasText: '合成模型请求超时' }).waitFor();
    await page.getByText('推理输出', { exact: true }).click();
    await page.getByLabel('克隆任务日志').getByText('合成推理片段', { exact: true }).waitFor();
    await page.getByRole('radio').nth(1).press('ArrowRight');
    if ((await page.getByRole('radio').nth(2).getAttribute('aria-checked')) !== 'true')
      throw new Error('键盘切换失败');
    const fit = await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        [...document.querySelectorAll('.weq-clone-task-log pre, [role="radio"]')].every((node) => {
          const r = node.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth;
        }),
    );
    if (!fit) throw new Error(`布局溢出：${theme}/${width}`);
    const palette = await page.evaluate(() => {
      const styles = (selector) =>
        [...document.querySelectorAll(selector)].map((node) => {
          const style = getComputedStyle(node);
          return { background: style.backgroundColor, color: style.color, height: style.height };
        });
      return {
        surfaces: styles('.weq-exp-log, .weq-help-log-view, .weq-model-log'),
        muted: styles('.weq-exp-log-time, .weq-exp-log-empty, .weq-log-ts'),
        warnings: styles('.is-warn .weq-exp-log-text, .is-warn .weq-log-msg'),
        errors: styles('.is-error .weq-exp-log-text, .is-error .weq-log-msg'),
        previewCount: document.querySelectorAll('.weq-exp-detail-tasklog .weq-exp-log-line').length,
        scrollHeight: getComputedStyle(document.querySelector('.weq-exp-log.is-scrollable')).height,
        exportHeight: getComputedStyle(document.querySelector('.weq-exp-log.is-export-scrollable'))
          .height,
      };
    });
    assert.ok(palette.surfaces.length >= 6);
    for (const surface of palette.surfaces) {
      assert.equal(surface.background, 'rgb(13, 20, 32)', `${theme}/${width}`);
      assert.equal(surface.color, 'rgb(200, 211, 224)', `${theme}/${width}`);
      assert.ok(contrast(surface.color, surface.background) >= 4.5);
    }
    for (const [group, expected] of [
      [palette.muted, 'rgb(133, 149, 172)'],
      [palette.warnings, 'rgb(226, 179, 90)'],
      [palette.errors, 'rgb(239, 107, 107)'],
    ]) {
      assert.ok(group.length > 0);
      for (const style of group) {
        assert.equal(style.color, expected);
        assert.ok(contrast(style.color, 'rgb(13, 20, 32)') >= 4.5);
      }
    }
    assert.equal(palette.previewCount, 5);
    assert.equal(palette.scrollHeight, '240px');
    assert.equal(palette.exportHeight, '180px');
    const suggestion = page.locator('[data-suggestion-log]');
    await suggestion.getByRole('button', { name: '模拟开始', exact: true }).click();
    assert.equal(
      await suggestion.getByLabel('模型正文', { exact: true }).textContent(),
      '{"summary":',
    );
    await suggestion.getByRole('button', { name: '模拟片段', exact: true }).click();
    assert.equal(
      await suggestion.getByLabel('模型正文', { exact: true }).textContent(),
      '{"summary":"正在接收"',
    );
    assert.equal(
      await suggestion.getByRole('button', { name: '模型正文：查看原文', exact: true }).count(),
      0,
    );
    await suggestion.getByRole('button', { name: '模拟长输出', exact: true }).click();
    const scroll = suggestion.locator('.weq-model-log');
    assert.ok(await scroll.evaluate((node) => node.scrollTop > 0));
    await scroll.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll'));
    });
    await suggestion.getByRole('button', { name: '模拟片段', exact: true }).click();
    assert.equal(await scroll.evaluate((node) => node.scrollTop), 0);
    await scroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event('scroll'));
    });
    await suggestion.getByRole('button', { name: '模拟片段', exact: true }).click();
    assert.ok(
      await scroll.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop < 24),
    );
    await suggestion.getByRole('button', { name: '模拟完成', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[data-suggestion-log] [aria-label="模型正文"] .weq-model-log-token[style]',
        ).length > 1,
    );
    const formatted = await suggestion.getByLabel('模型正文', { exact: true }).textContent();
    assert.ok(formatted.includes('\n  "summary": '));
    await suggestion.getByRole('button', { name: '模型正文：查看原文', exact: true }).click();
    assert.equal(
      (await suggestion.getByLabel('模型正文', { exact: true }).textContent()).includes('\n'),
      false,
    );
    await suggestion.getByRole('button', { name: '模型正文：格式化 JSON', exact: true }).click();
    await suggestion.locator('summary').filter({ hasText: 'User Prompt' }).click();
    assert.ok(await suggestion.getByLabel('User Prompt', { exact: true }).isVisible());
    await suggestion.locator('summary').filter({ hasText: 'User Prompt' }).click();
    const overflows = await page
      .locator('.weq-model-log, .weq-model-log pre')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.clientWidth && node.scrollWidth > node.clientWidth + 1)
          .map((node) => node.className),
      );
    assert.deepEqual(overflows, []);
    if (output)
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
    if (output)
      await suggestion.screenshot({ path: resolve(output, `${theme}-${width}-model.png`) });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    '日志：5 组主题、主题色、背景及视口配色/对比度检查通过；JSON 高亮、原文切换、提示词折叠、流式更新、手动滚动与自动跟随、克隆请求切换通过。',
  );
} finally {
  await browser?.close();
  await server.close();
}
