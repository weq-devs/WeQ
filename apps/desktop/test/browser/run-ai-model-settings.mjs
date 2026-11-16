import assert from 'node:assert/strict';
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
  cacheDir: resolve(root, 'node_modules/.vite-ai-model-settings'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/ai-model-settings.stub.ts'),
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
  const output = process.env.WEQ_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/ai-model-settings.html`,
      );
      await page.getByText('功能与模型', { exact: true }).waitFor();
      await page.evaluate((theme) => {
        const store = window.aiSettingsTheme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        store.setBackground(theme === 'light' ? 'grid' : 'telegram');
      }, theme);
      for (const title of ['意图感知', '互动画像', '推荐回复']) {
        await page.locator('nav').getByRole('button', { name: title, exact: true }).click();
        assert.equal(await page.locator('details').count(), 0);
        assert.ok((await page.locator('.weq-set-card').count()) > 1);
        const mode = page.getByRole('radiogroup', { name: `${title}模式`, exact: true });
        assert.deepEqual(await mode.getByRole('radio').allTextContents(), ['自动', '手动']);
        assert.equal(
          await mode.getByRole('radio', { name: '自动', exact: true }).getAttribute('aria-checked'),
          'true',
        );
        const model = page.getByLabel(`${title} API 模型`, { exact: true });
        assert.equal(await model.inputValue(), 'default');
        assert.equal(await model.locator('option[value=""]').count(), 0);
        assert.equal(
          await model.locator('option:checked').textContent(),
          '默认（当前：gpt-fixture-long-model-name）',
        );
        if (title !== '互动画像') {
          const trigger = page.getByRole('switch', {
            name: title === '意图感知' ? '自己发送后分析' : '自己发送后推荐回复',
            exact: true,
          });
          const checked = await trigger.getAttribute('aria-checked');
          await mode.getByRole('radio', { name: '手动', exact: true }).click();
          await trigger.waitFor({ state: 'detached' });
          await mode.getByRole('radio', { name: '自动', exact: true }).click();
          await trigger.waitFor();
          assert.equal(await trigger.getAttribute('aria-checked'), checked);
        } else {
          const engine = page.getByRole('radiogroup', { name: '互动画像运行方式', exact: true });
          const temperature = page.getByLabel('画像推断温度', { exact: true });
          const value = await temperature.inputValue();
          await engine.getByRole('radio', { name: '本地模型', exact: true }).click();
          await temperature.waitFor({ state: 'detached' });
          assert.equal(await page.getByLabel('模型推断话题上限', { exact: true }).count(), 0);
          await page.getByLabel('模型推断采样上限（条）', { exact: true }).waitFor();
          await engine.getByRole('radio', { name: 'API 模型', exact: true }).click();
          await temperature.waitFor();
          assert.equal(await temperature.inputValue(), value);
        }
        if (title === '推荐回复') {
          const expiry = page.getByLabel('最近推荐过期时间（分钟）', { exact: true });
          assert.equal(await expiry.inputValue(), '1');
          assert.equal(await expiry.getAttribute('min'), '-1');
          assert.ok(
            (await expiry.locator('xpath=ancestor::section[1]').textContent()).includes(
              '-1 表示永不过期',
            ),
          );
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        if (output)
          await page.screenshot({
            path: resolve(output, `${title}-${theme}-${width}.png`),
            fullPage: true,
          });
        if (title === '推荐回复') {
          const entry = page.getByRole('button', { name: '管理回退内容列表', exact: true });
          assert.equal(await page.getByRole('dialog', { name: '回退内容列表' }).count(), 0);
          assert.equal(await page.locator('main .weq-suggestion-fallback').count(), 0);
          await entry.click();
          const dialog = page.getByRole('dialog', { name: '回退内容列表', exact: true });
          await dialog.waitFor();
          assert.equal(await dialog.locator('.weq-set-card').count(), 0);
          const box = await dialog.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width);
          assert.ok(box.y >= 0 && box.y + box.height <= 900);
          assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
          assert.equal(
            await dialog.locator('.weq-dialog-body').evaluate((node) => {
              node.scrollTop = node.scrollHeight;
              return node.scrollTop > 0;
            }),
            true,
          );
          await dialog.getByLabel('添加回退内容', { exact: true }).click();
          const inputs = dialog.getByRole('textbox');
          const count = await inputs.count();
          await inputs.last().fill(`新增回退内容-${theme}-${width}`);
          await inputs.last().press('Enter');
          await dialog.getByRole('status').filter({ hasText: '已保存' }).waitFor();
          await inputs.first().fill(' ');
          await inputs.first().press('Enter');
          await dialog.getByRole('alert').first().waitFor();
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
          assert.equal(await entry.evaluate((node) => node === document.activeElement), true);
          await entry.click();
          await dialog.waitFor();
          assert.equal(await inputs.first().inputValue(), ' ');
          const updated = `更新后的回退内容-${theme}-${width}`;
          await inputs.first().fill(`  ${updated}  `);
          await inputs.first().press('Enter');
          await dialog.getByRole('status').filter({ hasText: '已保存' }).waitFor();
          await page.waitForFunction(
            (updated) => window.aiSettingsStatus().suggestionFallbackTexts[0] === updated,
            updated,
          );
          await dialog.getByLabel(`删除回退内容 ${count}`, { exact: true }).click();
          assert.equal(await inputs.count(), count - 1);
          await dialog.getByRole('status').filter({ hasText: '已保存' }).waitFor();
          if (output)
            await page.screenshot({
              path: resolve(output, `回退内容列表-${theme}-${width}.png`),
            });
          await dialog.getByLabel('关闭回退内容列表', { exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
        }
        await page
          .locator('nav')
          .getByRole('button', {
            name: title === '推荐回复' ? '意图感知' : '推荐回复',
            exact: true,
          })
          .click();
        await page.locator('nav').getByRole('button', { name: title, exact: true }).click();
        assert.equal(await page.locator('details').count(), 0);
        cases++;
      }
    }
  }
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/ai-model-settings.html?local-model=1`,
      );
      await page.getByLabel('意图模型资源', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('意图感知温度', { exact: true }).count(), 0);
      await page.evaluate((theme) => window.aiSettingsTheme.getState().setPreference(theme), theme);
      assert.equal(await page.locator('.weq-set-card .weq-set-card').count(), 0);
      const owner = page
        .locator('[data-setting-id="intent-model-resources"]')
        .locator('xpath=ancestor::section[1]');
      assert.equal(await owner.locator('.weq-set-card-title').textContent(), '功能与模型');
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (output)
        await page.screenshot({
          path: resolve(output, `意图资源-${theme}-${width}.png`),
          fullPage: true,
        });
      cases++;
    }
  }
  const touchContext = await browser.newContext({
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  try {
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', (error) => errors.push(error.message));
    await touchPage.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    for (const theme of ['light', 'dark']) {
      await touchPage.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/ai-model-settings.html`,
      );
      await touchPage.getByText('功能与模型', { exact: true }).waitFor();
      await touchPage.evaluate(
        (theme) => window.aiSettingsTheme.getState().setPreference(theme),
        theme,
      );
      await touchPage.locator('nav').getByRole('button', { name: '推荐回复', exact: true }).tap();
      await touchPage.getByLabel('管理回退内容列表', { exact: true }).tap();
      const dialog = touchPage.getByRole('dialog', { name: '回退内容列表', exact: true });
      await dialog.waitFor();
      for (const label of ['关闭回退内容列表', '删除回退内容 1']) {
        const bounds = await dialog.getByLabel(label, { exact: true }).boundingBox();
        assert.ok(bounds.width >= 44 && bounds.height >= 44);
      }
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 640);
      if (output)
        await touchPage.screenshot({ path: resolve(output, `回退内容列表-touch-${theme}.png`) });
      await dialog.getByLabel('关闭回退内容列表', { exact: true }).tap();
      await dialog.waitFor({ state: 'hidden' });
      cases++;
    }
  } finally {
    await touchContext.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
