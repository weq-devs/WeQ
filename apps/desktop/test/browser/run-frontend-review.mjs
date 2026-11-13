import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_REVIEW_QA ?? resolve(root, 'out/frontend-review');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WEQ_BROWSER_EXECUTABLE
    ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
    : {}),
});
let server;
const cases = [];
const errors = [];
async function start(stub) {
  await server?.close();
  server = await createServer({
    configFile: false,
    root,
    cacheDir: resolve(root, `node_modules/.vite-review-${stub}`),
    plugins: [react(), tailwind()],
    define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
    resolve: {
      alias: [
        { find: /^.*\/trpc\/client$/, replacement: resolve(root, `test/browser/${stub}.stub.ts`) },
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
  await server.listen();
  return `http://127.0.0.1:${server.httpServer.address().port}/test/browser`;
}
const page = await browser.newPage();
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', (route) =>
  new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
);
await page.emulateMedia({ reducedMotion: 'reduce' });
async function assertFits(label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  assert.equal(overflow, false, `${label} 页面溢出`);
  const clipped = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.weq-assistant-parameters, .weq-cvs-dialog, .weq-cvs-body-scroll, .weq-search-filters, .weq-mail-list',
      ),
    ]
      .filter(
        (node) => node.getBoundingClientRect().width > 0 && node.scrollWidth > node.clientWidth + 2,
      )
      .map((node) => node.className),
  );
  assert.deepEqual(clipped, [], `${label} 内部横向溢出`);
}
try {
  let base = await start('unified-conversation');
  for (const width of [320, 390, 768, 1440])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/unified-conversation.html?kind=assistant`);
      await page.locator('.chat-pane .composer-editor').waitFor();
      await page.evaluate((theme) => window.unifiedTheme(theme), theme);
      await page.waitForTimeout(100);
      for (const name of ['发红包', '通话', '语音', '发送图片或文件', '发送 Ark 卡片', '位置'])
        assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, name);
      await assertFits(`助手 ${width}/${theme}`);
      assert.ok(await page.getByText('模型', { exact: true }).isVisible());
      assert.ok(await page.getByText('思考', { exact: true }).isVisible());
      assert.equal(await page.locator('.weq-ai-attachments').count(), 0);
      const directSettings = page.getByRole('button', { name: '助手设置', exact: true });
      if (await directSettings.count()) await directSettings.click();
      else {
        await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
        assert.equal(
          await page.getByRole('menuitem', { name: '拉取漫游消息', exact: true }).count(),
          0,
        );
        await page.getByRole('menuitem', { name: '助手设置', exact: true }).click();
      }
      await page.getByRole('button', { name: '提示与工具', exact: true }).click();
      const prompt = page.getByLabel('额外提示词', { exact: true });
      await prompt.fill(`合成自动保存 ${width}/${theme}`);
      await page.getByRole('status').filter({ hasText: '未保存' }).waitFor();
      await page
        .getByRole('status')
        .filter({ hasText: /^已保存$/ })
        .waitFor();
      assert.equal(await prompt.inputValue(), `合成自动保存 ${width}/${theme}`);
      await assertFits(`设置 ${width}/${theme}`);
      await page.screenshot({ path: resolve(output, `settings-${width}-${theme}.png`) });
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.screenshot({ path: resolve(output, `assistant-${width}-${theme}.png`) });
      cases.push({ surface: 'assistant', width, theme });
    }
  for (const style of ['qqnt', 'classic', 'minimal', 'retro']) {
    await page.evaluate((style) => {
      document.documentElement.dataset.componentStyle = style;
    }, style);
    await assertFits(`助手皮肤 ${style}`);
  }
  await page.evaluate(() => {
    document.getElementById('root').style.maxWidth = '480px';
  });
  await page.waitForTimeout(100);
  await assertFits('宽窗窄助手面板');
  await page.screenshot({ path: resolve(output, 'assistant-wide-narrow-pane.png') });
  cases.push({ surface: 'assistant', width: 1440, paneWidth: 480 });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/conversation-search.html`);
    await page.locator('[aria-label="搜索来源"]').waitFor({ state: 'attached' });
    if (width <= 560) {
      assert.equal(
        await page.getByRole('group', { name: '搜索来源', exact: true }).isVisible(),
        false,
      );
      await page.getByRole('button', { name: /来源.*筛选/ }).click();
    }
    await page.getByRole('button', { name: '全部来源', exact: true }).click();
    assert.equal(await page.locator('.weq-search-empty').count(), 1);
    assert.ok((await page.locator('.weq-search-empty').textContent()).includes('未选择搜索范围'));
    await page.getByRole('button', { name: '恢复全部范围', exact: true }).click();
    await assertFits(`搜索 ${width}`);
    cases.push({ surface: 'search', width });
  }
  for (const width of [320, 390, 768, 1440])
    for (const theme of ['light', 'dark'])
      for (const style of ['qqnt', 'classic', 'minimal', 'retro']) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}/frontend-review.html`);
        await page.getByRole('button', { name: '打开会话', exact: true }).waitFor();
        await page.evaluate(
          ({ theme, style }) =>
            window.reviewQa.theme(theme, theme === 'light' ? '#0099ff' : '#f5e193', style),
          { theme, style },
        );
        assert.ok(
          (await page.evaluate(() => window.reviewQa.contrast())) >= 4.5,
          `${width}/${theme}/${style} 主按钮对比度`,
        );
        await page.getByRole('combobox', { name: '时间范围', exact: true }).selectOption('7d');
        await page.getByRole('radio', { name: '精确选择', exact: true }).click();
        await page.getByRole('radio', { name: '按条件', exact: true }).click();
        await assertFits(`导出控件 ${width}/${theme}/${style}`);
        if (width === 320 || width === 1440)
          await page.screenshot({
            path: resolve(output, `controls-${width}-${theme}-${style}.png`),
            fullPage: true,
          });
        cases.push({ surface: 'controls', width, theme, style });
      }
  base = await start('settings-audit');
  for (const width of [320, 390, 768, 1440])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/mail-audit.html?scenario=ready`);
      await page.locator('.weq-mail-row').first().waitFor();
      await page.evaluate(
        (theme) => window.mailAuditQa.theme.getState().setPreference(theme),
        theme,
      );
      await page.waitForTimeout(100);
      await assertFits(`邮箱 ${width}/${theme}`);
      const separator = page.getByRole('separator', { name: '调整邮件列表宽度' });
      if (width > 646) {
        await separator.focus();
        await page.keyboard.press('ArrowRight');
        const box = await separator.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(box.x + 35, box.y + 100);
        await page.mouse.up();
        const restored = Number(await separator.getAttribute('aria-valuenow'));
        const cancelBox = await separator.boundingBox();
        await page.mouse.move(cancelBox.x + 2, cancelBox.y + 100);
        await page.mouse.down();
        await page.mouse.move(cancelBox.x + 22, cancelBox.y + 100);
        await separator.evaluate((node) =>
          node.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })),
        );
        await page.mouse.up();
        assert.equal(
          Number(await separator.getAttribute('aria-valuenow')),
          restored,
          '取消拖动恢复起点',
        );
        if (width === 1440 && theme === 'light') {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Emulation.setTouchEmulationEnabled', {
            enabled: true,
            maxTouchPoints: 1,
          });
          const touchBox = await separator.boundingBox();
          const x = touchBox.x + 2,
            y = touchBox.y + 100;
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x, y }],
          });
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x + 24, y }],
          });
          assert.ok(
            Number(await separator.getAttribute('aria-valuenow')) > restored,
            '触屏拖动改变列宽',
          );
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
          await cdp.detach();
        }
        const sizes = await page.evaluate(() => ({
          list: document.querySelector('.weq-mail-list').getBoundingClientRect().width,
          reader: document.querySelector('.weq-mail-reader-shell').getBoundingClientRect().width,
          clamp: getComputedStyle(document.querySelector('.weq-mail-row-subject > span'))
            .webkitLineClamp,
        }));
        assert.ok(sizes.list >= 280 && sizes.list <= 560);
        assert.ok(sizes.reader >= 359);
        assert.equal(sizes.clamp, '2');
      }
      await page.screenshot({ path: resolve(output, `mail-${width}-${theme}.png`) });
      cases.push({ surface: 'mail', width, theme });
    }
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ cases, errors }, null, 2));
  console.log(JSON.stringify({ cases: cases.length, errors, output }));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await server?.close();
}
