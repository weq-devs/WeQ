import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_SMALL_CONTROLS_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-small-controls'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/small-controls.stub.ts'),
      },
      {
        find: /^.*\/hooks\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/small-controls.stub.ts'),
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
  const image = await readFile(resolve(root, '../../resources/qqlevel/penguin.png'));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (
      url.pathname === '/_media/album' ||
      url.pathname === '/_avatar/fetch' ||
      url.pathname === '/resources/qqlevel/penguin.png'
    )
      return route.fulfill({ contentType: 'image/png', body: image });
    return route.continue();
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/small-controls.html`;
  if (output) await mkdir(output, { recursive: true });
  const save = async (name) => {
    if (output) await page.screenshot({ path: resolve(output, `${name}.png`) });
  };
  const checkOverflow = async (selector) => {
    const failures = await page
      .locator(selector)
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.scrollWidth > node.clientWidth + 1)
          .map((node) => node.className),
      );
    assert.deepEqual(failures, [], `${selector}: 横向溢出`);
  };
  const checkContrast = async (button, label) => {
    const ratio = await button.evaluate((node) => {
      const context = document.createElement('canvas').getContext('2d');
      const rgba = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const blend = (front, back) =>
        front
          .slice(0, 3)
          .map((value, i) => (value * front[3]) / 255 + back[i] * (1 - front[3] / 255));
      const parents = [];
      for (let parent = node; parent; parent = parent.parentElement) parents.unshift(parent);
      const background = parents.reduce(
        (color, element) => blend(rgba(getComputedStyle(element).backgroundColor), color),
        [255, 255, 255],
      );
      const foreground = blend(rgba(getComputedStyle(node).color), background);
      const luminance = (color) =>
        color
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
      const values = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    });
    assert.ok(ratio >= 4.5, `${label}: 按钮文字对比度 ${ratio}`);
  };
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 850 });
    for (const theme of ['light', 'dark']) {
      for (const style of ['classic', 'minimal', 'retro', 'qqnt']) {
        const label = `${width}-${theme}-${style}`;
        await page.goto(url);
        await page.getByRole('button', { name: '历史头像', exact: true }).waitFor();
        await page.evaluate(
          ({ theme, style }) => {
            const store = window.smallControlsTheme.getState();
            store.setPreference(theme);
            store.setComponentStyle(style);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setBackground(theme === 'light' ? 'grid' : 'telegram');
          },
          { theme, style },
        );
        const titles = await page
          .locator('[data-title-samples] :is(h2,h3,h4)')
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              text: node.textContent,
              weight: getComputedStyle(node).fontWeight,
              lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
              size: Number.parseFloat(getComputedStyle(node).fontSize),
            })),
          );
        assert.equal(titles.length, 12);
        for (const title of titles) {
          assert.equal(title.weight, '600', `${label}: ${title.text}`);
          assert.equal(title.lineHeight, title.size * 1.5, `${label}: ${title.text}`);
        }
        await page.getByRole('button', { name: '历史头像', exact: true }).click();
        const dialog = page.locator('.weq-avatar-history-dialog');
        await dialog.waitFor();
        const change = dialog.getByRole('button', { name: '更换头像', exact: true });
        assert.equal(
          await dialog.locator('h2').evaluate((node) => getComputedStyle(node).fontWeight),
          '600',
        );
        const appearance = await change.evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            size: style.fontSize,
            border: style.borderBottomWidth,
            background: style.backgroundColor,
            weight: style.fontWeight,
          };
        });
        assert.equal(appearance.size, '13px', label);
        assert.ok(Number.parseFloat(appearance.border) >= 1, label);
        if (style !== 'minimal') assert.notEqual(appearance.background, 'rgba(0, 0, 0, 0)', label);
        assert.equal(appearance.weight, '600', label);
        await checkContrast(change, label);
        await change.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        assert.notEqual(
          await change.evaluate((node) => getComputedStyle(node).outlineStyle),
          'none',
        );
        const sort = dialog.getByRole('radio', { name: '最早使用时间' });
        await sort.click();
        await sort.press('ArrowRight');
        assert.equal(
          await dialog.getByRole('radio', { name: '最后使用时间' }).getAttribute('aria-checked'),
          'true',
        );
        await checkOverflow(
          '.weq-avatar-history-dialog, .weq-avatar-history-header, .weq-avatar-history-toolbar, .weq-avatar-history-grid',
        );
        await page.waitForFunction(
          () =>
            document.querySelectorAll('.weq-avatar-history-image img').length === 6 &&
            [...document.querySelectorAll('.weq-avatar-history-image img')].every(
              (img) => img.complete && img.naturalWidth > 0,
            ),
        );
        if (style === 'classic') await save(`${label}-avatars`);
        await dialog.getByRole('button', { name: '关闭历史头像' }).click();
        await page.getByRole('button', { name: '新建分组', exact: true }).click();
        const editor = page.locator('.weq-friend-directory-editor');
        const submit = editor.getByRole('button', { name: '保存', exact: true });
        assert.equal(await submit.isDisabled(), true);
        await editor.getByRole('textbox').fill('合成分组名称');
        assert.equal(await submit.isEnabled(), true);
        await checkContrast(submit, label);
        const colors = await editor.locator('footer button').evaluateAll((nodes) =>
          nodes.map((node) => {
            const style = getComputedStyle(node);
            return [style.backgroundColor, style.color, style.borderBottomWidth];
          }),
        );
        assert.notDeepEqual(colors[0], colors[1], `${label}: 保存和取消无层次`);
        await checkOverflow('.weq-friend-directory-editor, .weq-friend-directory-editor footer');
        if (style === 'classic') await save(`${label}-directory`);
        await submit.click();
        await editor.waitFor({ state: 'detached' });
        assert.deepEqual(await page.evaluate(() => window.smallControlsQa.operations), [
          'category',
        ]);
        await page.getByRole('button', { name: '删除分组', exact: true }).click();
        assert.equal(
          await editor
            .getByRole('button', { name: '删除', exact: true })
            .evaluate((node) => node.classList.contains('weq-set-btn-danger')),
          true,
        );
        await editor.getByRole('button', { name: '取消', exact: true }).click();
        cases++;
      }
    }
  }
  for (const state of ['offline', 'error', 'loading']) {
    await page.goto(`${url}?${state}`);
    await page.getByRole('button', { name: '历史头像', exact: true }).click();
    const change = page.getByRole('button', { name: '更换头像', exact: true });
    assert.equal(await change.isDisabled(), state === 'offline');
    if (state === 'error') {
      const retry = page.locator('.weq-avatar-history-error button');
      assert.equal(await retry.evaluate((node) => getComputedStyle(node).fontSize), '13px');
    }
    await save(`avatar-${state}`);
    cases++;
  }
  await page.goto(url);
  await page.getByRole('button', { name: '历史头像', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '更换头像', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: '更换头像', exact: true }).getAttribute('aria-busy'),
    'true',
  );
  await (await chooser).setFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: image });
  await page.waitForFunction(() => window.smallControlsQa.operations.includes('avatar'));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ cases: cases + 1, titleChecks: 24 * 12, avatarUpload: true, errors }),
  );
} finally {
  await browser?.close();
  await server.close();
}
