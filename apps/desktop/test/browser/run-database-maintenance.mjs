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
const stub = resolve(root, 'test/browser/database-maintenance.stub.ts');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-database-maintenance'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/(QqAvatar|Toast|useQQAutoRefresh)$/, replacement: stub },
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
  const output = process.env.WEQ_MAINTENANCE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1060])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 780 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/database-maintenance.html`,
      );
      await page.waitForFunction(() => window.maintenanceQa);
      await page.evaluate((theme) => {
        const store = window.maintenanceQa.theme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#006d50' : '#ffe593');
        window.maintenanceQa.structure();
      }, theme);
      await page.getByText('检查页结构与引用', { exact: true }).waitFor();
      const capture = async (name) => {
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        const overflows = await page.locator('.weq-db-progress *').evaluateAll((nodes) =>
          nodes
            .filter((node) => {
              const box = node.getBoundingClientRect();
              return (
                box.width > 0 &&
                (box.left < -1 ||
                  box.right > innerWidth + 1 ||
                  node.scrollWidth > node.clientWidth + 1)
              );
            })
            .map((node) => node.className),
        );
        assert.deepEqual(overflows, []);
        if (output)
          await page.screenshot({
            path: `${output}/${name}-${width}-${theme}.png`,
            fullPage: true,
          });
        cases++;
      };
      const assertCardBorders = async (selector) => {
        const missing = await page.locator(selector).evaluateAll((cards) => {
          const context = document.createElement('canvas').getContext('2d');
          return cards.flatMap((card) => {
            const style = getComputedStyle(card);
            return ['Top', 'Right', 'Bottom', 'Left'].flatMap((side) => {
              context.clearRect(0, 0, 1, 1);
              context.fillStyle = style[`border${side}Color`];
              context.fillRect(0, 0, 1, 1);
              return Number.parseFloat(style[`border${side}Width`]) > 0 &&
                style[`border${side}Style`] !== 'none' &&
                context.getImageData(0, 0, 1, 1).data[3] > 0
                ? []
                : [`${card.querySelector('.weq-rp-mono')?.textContent}: ${side}`];
            });
          });
        });
        assert.deepEqual(missing, [], '数据库卡片的四边均应可见');
      };
      const strip = page.getByRole('list', { name: '体检数据库列表' });
      const stripLayout = await strip.evaluate((node) => {
        const boxes = [...node.children].map((item) => item.getBoundingClientRect());
        return {
          rows: new Set(boxes.map((box) => box.y)).size,
          scrolls: node.scrollWidth > node.clientWidth,
          bottom: node.getBoundingClientRect().bottom,
        };
      });
      assert.equal(stripLayout.rows, 1);
      assert.equal(stripLayout.scrolls, true);
      const taskBox = await page.locator('.weq-rp-checkup-task').boundingBox();
      assert.ok(taskBox && taskBox.y >= stripLayout.bottom);
      const header = await page.locator('.weq-rp-head').evaluate((node) => ({
        left: getComputedStyle(node).paddingLeft,
        right: getComputedStyle(node).paddingRight,
      }));
      assert.equal(header.left, header.right);
      const identity = await page.locator('.weq-rp-account').evaluate((node) => ({
        tag: node.tagName,
        focusable: node.tabIndex >= 0,
        border: getComputedStyle(node).borderTopWidth,
        background: getComputedStyle(node).backgroundColor,
      }));
      assert.deepEqual(identity, {
        tag: 'SPAN',
        focusable: false,
        border: '0px',
        background: 'rgba(0, 0, 0, 0)',
      });
      assert.equal(await page.locator('.weq-db-progress-timeline').count(), 1);
      assert.equal(
        await page.locator('.weq-db-progress-groups, .weq-db-progress-history').count(),
        0,
      );
      assert.equal(
        await page
          .locator('.weq-db-progress')
          .getByText(/进度更新|本步骤/)
          .count(),
        0,
      );
      await capture('structure');
      await assertCardBorders('.weq-rp-db');
      await page.getByText('39.1%', { exact: true }).waitFor();
      await page.evaluate(() => window.maintenanceQa.structureRecords());
      await page.getByText('25.0%', { exact: true }).waitFor();
      await page.getByText('500 / 2,000 条记录', { exact: true }).waitFor();
      await capture('structure-records');
      for (const mode of ['diagnosing', 'normal', 'abnormal', 'unverified', 'failed']) {
        await page.evaluate((mode) => window.maintenanceQa.checkupOutcome(mode), mode);
        const timeline = page.locator('.weq-db-progress');
        if (mode === 'diagnosing' || mode === 'abnormal') {
          await timeline.getByText('提前结束', { exact: true }).waitFor();
          await timeline.getByText('4,336,384 / 4,567,177 页', { exact: true }).waitFor();
          assert.equal(await timeline.locator('.is-incomplete .lucide-check').count(), 0);
          assert.ok((await timeline.locator('.is-abnormal').count()) > 0);
          await strip.getByText('已发现异常', { exact: true }).waitFor();
          assert.equal(
            await strip
              .locator('.weq-rp-chip.is-warn')
              .evaluate((node) => getComputedStyle(node).display),
            'flex',
          );
          await page.getByText('已发现异常，仍在继续体检。', { exact: true }).waitFor();
          assert.match(await page.locator('.weq-rp-batch').innerText(), /已发现异常\s+1 个/);
        }
        if (mode === 'normal') await timeline.getByText('正常', { exact: true }).first().waitFor();
        if (mode === 'unverified') await timeline.getByText('无法校验', { exact: true }).waitFor();
        if (mode === 'failed') {
          await timeline.getByText('检查失败', { exact: true }).waitFor();
          await strip.getByText('部分检查失败', { exact: true }).waitFor();
        }
        await capture(`outcome-${mode}`);
      }
      await strip.locator('button').last().focus();
      assert.ok((await strip.evaluate((node) => node.scrollLeft)) > 0);
      await strip.evaluate((node) => {
        node.scrollLeft = 0;
      });
      await page.evaluate(() => window.maintenanceQa.checkup());
      await page.getByText('34.8%', { exact: true }).waitFor();
      await capture('checkup');
      await page.getByRole('button', { name: '跳过体检，直接选数据库 →' }).click();
      await assertCardBorders('.weq-rp-pick');
      await page.locator('.weq-rp-pick').first().click();
      await page.getByRole('button', { name: '开始修复', exact: true }).click();
      await page.getByRole('button', { name: '确认替换并修复', exact: true }).click();
      await page.evaluate(() => window.maintenanceQa.repair());
      await page.getByText('62.4%', { exact: true }).waitFor();
      const consoleBox = await page.locator('.weq-db-progress').boundingBox();
      assert.ok(consoleBox && consoleBox.y >= 0 && consoleBox.y + 190 < 780);
      assert.equal(await page.locator('.weq-rp-preparation').getAttribute('open'), null);
      await capture('repair');
      await page.evaluate(() => window.maintenanceQa.repair('Repair'));
      assert.equal(
        await page
          .locator('.weq-db-progress .weq-task-progress-track progress')
          .getAttribute('value'),
        null,
      );
      await capture('rebuild');
      await page.evaluate(() => window.maintenanceQa.longRepair());
      const current = page.locator('.weq-db-progress-entry[aria-current="step"]');
      await current.waitFor();
      const currentBox = await current.boundingBox();
      assert.ok(currentBox && currentBox.y + currentBox.height < 780);
      assert.equal(await page.getByText('恢复已完成表 0', { exact: true }).count(), 0);
      const earlier = page.locator('.weq-db-progress-expand button');
      await earlier.click();
      await page.getByText('恢复已完成表 0', { exact: true }).waitFor();
      assert.equal(await page.getByText('恢复表数据', { exact: true }).count(), 1);
      await earlier.click();
      await capture('long-repair');
      await page.evaluate(() => window.maintenanceQa.disconnect());
      await page
        .getByText('进度连接中断，正在重新连接；任务结果尚未确认。', { exact: true })
        .waitFor();
      await capture('disconnected');
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, firstViewport: true, responsive: true }));
} finally {
  await browser?.close();
  await server.close();
}
