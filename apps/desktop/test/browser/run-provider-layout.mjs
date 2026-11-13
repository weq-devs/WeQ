import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_SETTINGS_ARTIFACTS ?? resolve(root, 'out/provider-layout');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-provider-layout'),
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
  await page.addInitScript(() => localStorage.clear());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  let cases = 0;
  for (const width of [1280, 640, 390, 320]) {
    await page.setViewportSize({ width, height: width === 640 ? 540 : 900 });
    for (const theme of ['light', 'dark']) {
      for (const style of ['qqnt', 'classic', 'minimal', 'retro']) {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/ai-model-settings.html`,
        );
        await page.getByRole('button', { name: 'API 配置', exact: true }).click();
        await page.evaluate(
          ({ theme, style }) => {
            const store = window.aiSettingsTheme.getState();
            store.setPreference(theme);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setComponentStyle(style);
            store.setBackground(theme === 'light' ? 'grid' : 'telegram');
          },
          { theme, style },
        );
        const provider = page.locator('.weq-agentlab-provider-item');
        await provider.waitFor();
        const heading = await provider.locator('.weq-agentlab-provider-name').evaluate((node) => {
          const icon = node.querySelector('svg').getBoundingClientRect();
          const text = [...node.childNodes].find(
            (child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim(),
          );
          const range = document.createRange();
          range.selectNodeContents(text);
          const name = range.getBoundingClientRect();
          return {
            icon: { right: icon.right, y: icon.y, height: icon.height },
            name: { x: name.x, y: name.y, height: name.height },
          };
        });
        assert.ok(heading.icon.right <= heading.name.x, '服务商图标应在名称左侧');
        assert.ok(
          Math.abs(
            heading.icon.y + heading.icon.height / 2 - heading.name.y - heading.name.height / 2,
          ) <= 2,
          '服务商图标与名称应同行居中',
        );
        await page.screenshot({ path: resolve(output, `list-${width}-${theme}-${style}.png`) });
        await provider.click();
        const model = page.getByLabel('模型 1 ID', { exact: true });
        await model.fill('Qwen3.6-35B-A3B-4bit-with-a-long-model-identifier');
        const remove = page.getByRole('button', { name: '删除模型 1', exact: true });
        const detect = page.getByRole('button', { name: '自动检测模型 1 能力', exact: true });
        const reasoning = page.getByLabel('模型 1 思考档位', { exact: true });
        const idBox = await model.boundingBox();
        const removeBox = await remove.boundingBox();
        const detectBox = await detect.boundingBox();
        const reasoningBox = await reasoning.boundingBox();
        const capabilities = page.getByRole('group', { name: '模型 1 能力', exact: true });
        const capabilitiesBox = await capabilities.boundingBox();
        await page.screenshot({ path: resolve(output, `${width}-${theme}-${style}.png`) });
        assert.ok(removeBox.width <= 36, '删除模型应保持图标按钮宽度');
        assert.ok(Math.abs(idBox.y - removeBox.y) < 4, '删除按钮应与模型 ID 同行');
        assert.ok(detectBox.width <= 90, '能力检测按钮应按精简文案紧凑显示');
        assert.ok(detectBox.y > reasoningBox.y, '检测能力应位于思考档位下方');
        assert.equal(await detect.textContent(), '检测能力');
        assert.equal(await reasoning.getAttribute('placeholder'), '思考档位（逗号分隔）');
        if (width >= 640) {
          assert.ok(Math.abs(reasoningBox.y - idBox.y) < 4, '思考档位与模型 ID 应同行');
          assert.ok(Math.abs(detectBox.y - capabilitiesBox.y) < 4, '检测按钮与能力选项应同行');
          assert.ok(idBox.x + idBox.width <= reasoningBox.x, '模型 ID 在左、思考档位在右');
        }
        assert.ok(detectBox.x + detectBox.width <= capabilitiesBox.x, '检测按钮在左、能力选项在右');
        assert.ok(
          Math.abs(capabilitiesBox.x + capabilitiesBox.width - (removeBox.x + removeBox.width)) < 2,
          '能力选项应右对齐',
        );
        assert.equal(await capabilities.getByRole('checkbox').count(), 0);
        assert.equal(await capabilities.getByRole('button').count(), 3);
        const chat = capabilities.getByRole('button', { name: '聊天', exact: true });
        const vision = capabilities.getByRole('button', { name: '视觉', exact: true });
        assert.equal(await chat.getAttribute('aria-pressed'), 'true');
        await vision.click();
        assert.equal(await vision.getAttribute('aria-pressed'), 'true');
        assert.equal(await chat.getAttribute('aria-pressed'), 'true');
        await vision.press('Space');
        assert.equal(await vision.getAttribute('aria-pressed'), 'false');
        const content = await detect.evaluate((node) => {
          const button = node.getBoundingClientRect();
          const icon = node.querySelector('svg').getBoundingClientRect();
          const text = node.querySelector('span').getBoundingClientRect();
          const right = text.width ? text.right : icon.right;
          const top = text.height ? Math.min(icon.top, text.top) : icon.top;
          const bottom = text.height ? Math.max(icon.bottom, text.bottom) : icon.bottom;
          return {
            x: (icon.left + right - button.left - button.right) / 2,
            y: (top + bottom - button.top - button.bottom) / 2,
          };
        });
        assert.ok(
          Math.abs(content.x) <= 2 && Math.abs(content.y) <= 2,
          `检测按钮内容应居中 ${JSON.stringify(content)}`,
        );
        assert.equal(
          await page
            .locator('.weq-provider-modal')
            .evaluate((node) =>
              [...node.querySelectorAll('*'), node].some(
                (item) =>
                  item.scrollWidth > item.clientWidth + 2 &&
                  getComputedStyle(item).overflowX === 'visible',
              ),
            ),
          false,
          '弹窗内部不应横向溢出',
        );
        await page.getByRole('button', { name: '手动添加', exact: true }).click();
        assert.equal(await page.locator('.weq-provider-model-row').count(), 2);
        await page.getByRole('button', { name: '删除模型 2', exact: true }).click();
        assert.equal(await page.locator('.weq-provider-model-row').count(), 1);
        const footer = await page.locator('.weq-provider-modal-actions').boundingBox();
        assert.ok(footer.y + footer.height <= page.viewportSize().height, '底栏应保持可见');
        cases++;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, output }));
} finally {
  await browser?.close();
  await server.close();
}
