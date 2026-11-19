import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_COMPACT_DIALOG_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: 'node_modules/.vite-compact-dialogs',
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/compact-dialogs.stub.ts'),
      },
      {
        find: /^.*\/hooks\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/compact-dialogs.stub.ts'),
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
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/compact-dialogs.html`;
  if (output) await mkdir(output, { recursive: true });
  const dialog = page.locator('.weq-friend-directory-editor');
  const save = async (name) => {
    if (output) await page.screenshot({ path: resolve(output, `${name}.png`) });
  };
  const layout = async () => {
    const failures = await dialog
      .locator(':scope, header, form, footer, input, select, textarea, dl')
      .evaluateAll((nodes) =>
        nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.tagName),
      );
    assert.deepEqual(failures, [], '弹窗横向溢出');
    const bounds = await dialog.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= viewport.width + 1 &&
        bounds.y + bounds.height <= viewport.height + 1,
    );
    const controls = await dialog.locator('footer button').evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        const icon = node.querySelector('svg')?.getBoundingClientRect();
        const bounds = node.getBoundingClientRect();
        return {
          display: style.display,
          height: bounds.height,
          aligned: !icon || Math.abs(icon.y + icon.height / 2 - bounds.y - bounds.height / 2) <= 1,
        };
      }),
    );
    for (const control of controls) {
      assert.ok(['inline-flex', 'flex'].includes(control.display));
      assert.ok(control.height >= 36);
      assert.ok(control.aligned, '图标必须与文字同排居中');
    }
  };
  await page.goto(url);
  await dialog.waitFor();
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 850 });
    for (const theme of ['light', 'dark']) {
      for (const style of ['classic', 'retro', 'qqnt']) {
        await page.evaluate(
          ({ theme, style }) => {
            const store = window.compactDialogsQa.theme.getState();
            store.setPreference(theme);
            store.setComponentStyle(style);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setBackground(theme === 'light' ? 'grid' : 'telegram');
          },
          { theme, style },
        );
        for (const surface of ['user', 'group', 'album', 'create', 'move', 'delete']) {
          await page.evaluate(() => window.compactDialogsQa.show('closed'));
          await dialog.waitFor({ state: 'detached' });
          await page.evaluate((surface) => window.compactDialogsQa.show(surface), surface);
          if (surface === 'album')
            await page.getByRole('button', { name: '新建相册', exact: true }).click();
          await dialog.waitFor();
          assert.ok(await dialog.getAttribute('aria-labelledby'));
          const submit = dialog.locator('[type="submit"]');
          if (surface === 'user' || surface === 'group') {
            assert.ok(await submit.isDisabled());
            await dialog.locator('input').fill('10002');
            await submit.press('Enter');
            await dialog.locator('dl').waitFor();
          } else if (surface === 'album' || surface === 'create') {
            await dialog.locator('input').fill('合成名称');
          }
          await layout();
          if (
            style === 'classic' &&
            (width === 320 || width === 1180) &&
            ['user', 'album', 'move'].includes(surface)
          )
            await save(`${surface}-${width}-${theme}`);
          const field = dialog.locator('input, select, textarea').first();
          const unfocusedBorder = await field.evaluate((node) => {
            node.blur();
            return getComputedStyle(node).borderColor;
          });
          await field.focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
          assert.ok(await field.evaluate((node) => node === document.activeElement));
          assert.notEqual(
            await field.evaluate((node) => getComputedStyle(node).borderColor),
            unfocusedBorder,
            `${surface}-${width}-${theme}-${style}: 键盘焦点`,
          );
          cases++;
        }
      }
    }
  }
  for (const mode of ['long', 'error', 'loading', 'offline']) {
    await page.setViewportSize({ width: 320, height: 520 });
    await page.goto(`${url}?${mode === 'offline' ? 'offline' : `mode=${mode}`}`);
    await dialog.waitFor();
    await dialog.locator('input').fill('10002');
    if (mode === 'offline') {
      assert.ok(await dialog.locator('[type="submit"]').isDisabled());
      await dialog.getByRole('status').waitFor();
    } else {
      await dialog.locator('[type="submit"]').click();
      await dialog
        .locator(mode === 'error' ? '[role="alert"]' : mode === 'loading' ? '.animate-spin' : 'dl')
        .waitFor();
      if (mode === 'loading') assert.ok(await dialog.locator('[type="submit"]').isDisabled());
    }
    await layout();
    await dialog.locator('footer').scrollIntoViewIfNeeded();
    assert.ok(await dialog.locator('footer [type="button"]').isVisible());
    await save(`state-${mode}`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }
  assert.deepEqual(errors, []);
  console.log(`Compact dialogs: ${cases} layout cases + 4 feedback states passed.`);
} finally {
  await browser?.close();
  await server.close();
}
