import { chooseFormOption } from './form-select.mjs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-performance-monitor'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/performance-monitor.stub.ts'),
      },
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
const settingsOnly = process.argv.includes('--settings-only');
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/performance-monitor.html`;
  const output = process.env.WEQ_PERFORMANCE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const choose = async (target, label, value) => {
    await target.getByRole('button', { name: label, exact: true }).click();
    await target.getByRole('option', { name: value, exact: true }).click();
  };
  const assertCursorAlignment = async (monitor) => {
    const svg = monitor.locator('.weq-perf-chart svg').first();
    const target = await svg
      .locator('path.weq-perf-line')
      .first()
      .evaluate((path) => {
        const point = path.getPointAtLength(path.getTotalLength());
        const screen = point.matrixTransform(path.getScreenCTM());
        return { x: screen.x, y: screen.y };
      });
    await monitor.mouse.move(target.x, target.y);
    await monitor.waitForFunction((x) => {
      const cursors = [...document.querySelectorAll('.weq-perf-cursor')];
      return (
        cursors.length === 5 &&
        cursors.every((cursor) => Math.abs(cursor.getBoundingClientRect().x - x) < 1)
      );
    }, target.x);
  };
  for (const host of ['desktop', 'web']) {
    await page.goto(url + '?host=' + host);
    await page.getByRole('heading', { name: '日志与性能' }).waitFor();
    assert.deepEqual(await page.locator('.weq-set-card-title').allTextContents(), [
      '应用日志',
      '性能记录',
    ]);
    assert.equal(await page.locator('.weq-perf-chart').count(), 0);
    assert.equal(await page.getByRole('button', { name: '应用', exact: true }).count(), 0);
    assert.equal(await page.locator('select').count(), 0);
    assert.equal(await page.getByText('记录状态', { exact: true }).count(), 0);
    const spacing = await page
      .locator('[data-setting-id="performance-monitor"]')
      .evaluate((card) => {
        const form = card.querySelector('.weq-autosave');
        const gap = Number.parseFloat(getComputedStyle(card).rowGap);
        const rows = [...form.querySelectorAll(':scope > .weq-set-row')].map((row) =>
          row.getBoundingClientRect(),
        );
        return {
          gap,
          formGap: Number.parseFloat(getComputedStyle(form).rowGap),
          spaces: rows.slice(1).map((row, index) => row.top - rows[index].bottom),
        };
      });
    assert.equal(spacing.formGap, spacing.gap);
    assert.ok(spacing.spaces.every((gap) => gap >= spacing.gap - 1));
    assert.equal(await page.getByLabel('应用日志保存时长').textContent(), '7 天');
    assert.equal(
      await page.getByLabel('应用日志保存时长').evaluate((el) => el.getBoundingClientRect().width),
      160,
    );
    await choose(page, '应用日志保存时长', '自定义');
    const customDays = page.getByRole('spinbutton', { name: '应用日志保存时长（天）' });
    await customDays.fill('1');
    await customDays.press('Enter');
    await page.getByText('保存时长改为 1 天，将删除 2 份过期日志。').waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await customDays.inputValue(), '7');
    assert.equal(await page.evaluate(() => window.performanceQa.logChanges.length), 0);
    await choose(page, '应用日志容量上限', '1 GiB');
    await page.waitForFunction(() => window.performanceQa.logChanges.at(-1)?.capacityMiB === 1024);
    await page.getByRole('button', { name: '清空应用日志历史', exact: true }).click();
    await page.getByRole('button', { name: '清空历史', exact: true }).click();
    await page.waitForFunction(() => window.performanceQa.logClears === 1);
    await page.getByRole('radio', { name: '关闭', exact: true }).click();
    await page.waitForFunction(() => window.performanceQa.changes.length === 1);
    await page.getByRole('radio', { name: '完整记录', exact: true }).click();
    await page.waitForFunction(() => window.performanceQa.changes.length === 2);
    assert.equal(
      await page.evaluate(() => window.performanceQa.changes[1].fullDurationMinutes),
      60,
    );
    await choose(page, '性能记录保存时长', '30 天');
    await page.waitForFunction(() => window.performanceQa.changes.length === 3);
    assert.equal(await page.evaluate(() => window.performanceQa.changes[2].retentionDays), 30);
    assert.equal(
      await page.evaluate(() => window.performanceQa.changes[2].fullDurationMinutes),
      undefined,
    );
    await choose(page, '性能记录保存时长', '7 天');
    await page.waitForFunction(() => window.performanceQa.changes.length === 4);
    assert.equal(await page.getByRole('button', { name: '保存并删除', exact: true }).count(), 0);
    await page.evaluate(() => {
      window.performanceQa.historyAgeDays = 5;
    });
    await choose(page, '性能记录保存时长', '3 天');
    await page.getByRole('button', { name: '保存并删除', exact: true }).waitFor();
    await page.getByText('当前性能记录占用', { exact: false }).waitFor();
    await page.getByText('之前的 12 条记录', { exact: false }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.evaluate(() => window.performanceQa.changes.length), 4);
    assert.equal(await page.getByLabel('性能记录保存时长', { exact: true }).textContent(), '7 天');
    await choose(page, '性能记录保存时长', '3 天');
    await page.getByRole('button', { name: '保存并删除', exact: true }).click();
    await page.waitForFunction(() => window.performanceQa.changes.length === 5);
    assert.equal(await page.evaluate(() => window.performanceQa.changes.at(-1).confirmPrune), true);
    await page.evaluate(() => {
      window.performanceQa.storageBytes = 70 * 1048576;
      window.performanceQa.historyAgeDays = 1;
    });
    await choose(page, '性能记录容量上限', '64 MiB');
    await page.getByText('当前性能记录占用 70 MiB', { exact: false }).waitFor();
    await page.getByText('容量上限设为 64 MiB', { exact: false }).waitFor();
    await page.getByText('实际回收目标为 57.6 MiB', { exact: false }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(
      await page.getByLabel('性能记录容量上限', { exact: true }).textContent(),
      '128 MiB',
    );
    await page.evaluate(() => {
      window.performanceQa.storageBytes = 42_000;
    });
    await choose(page, '性能记录容量上限', '64 MiB');
    await page.waitForFunction(() => window.performanceQa.changes.length === 6);
    assert.equal(
      await page.evaluate(() => window.performanceQa.changes.at(-1).confirmPrune),
      false,
    );
    await choose(page, '性能记录保存时长', '不限时长');
    await page.waitForFunction(() => window.performanceQa.changes.at(-1)?.retentionDays === 0);
    await choose(page, '性能记录容量上限', '1 GiB');
    await page.waitForFunction(() => window.performanceQa.changes.at(-1)?.capacityMiB === 1024);
    await choose(page, '性能记录容量上限', '不限容量');
    await page.waitForFunction(() => window.performanceQa.changes.at(-1)?.capacityMiB === 0);
    if (output)
      await page.screenshot({ path: resolve(output, host + '-settings.png'), fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (output)
        await page.screenshot({
          path: resolve(output, host + '-settings-' + width + '-dark.png'),
          fullPage: true,
        });
    }
    await page.setViewportSize({ width: 1180, height: 900 });
    if (settingsOnly) continue;
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    const [monitor] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('button', { name: '打开性能监视' }).click(),
    ]);
    monitor.on('pageerror', (error) => errors.push(error.message));
    await monitor.locator('.weq-perf-chart svg').first().waitFor();
    assert.equal(await monitor.locator('.weq-perf-chart').count(), 5);
    await assertCursorAlignment(monitor);
    await monitor.mouse.move(0, 0);
    await monitor.getByRole('button', { name: '显示指标', exact: true }).click();
    assert.equal(
      await monitor.getByRole('checkbox', { name: 'JS 外部内存', exact: true }).isChecked(),
      true,
    );
    await monitor.keyboard.press('Escape');
    assert.deepEqual(await monitor.evaluate(() => ({ width: innerWidth, height: innerHeight })), {
      width: 1060,
      height: 740,
    });
    assert.equal(await monitor.getByRole('tab').count(), 0);
    assert.equal(await monitor.getByRole('button', { name: '记录设置', exact: true }).count(), 0);
    assert.equal(await monitor.locator('.weq-perf-inspector').count(), 0);
    assert.ok(
      (await monitor
        .getByLabel('进程', { exact: true })
        .evaluate((el) => el.getBoundingClientRect().width)) <= 170,
    );
    assert.deepEqual(
      await monitor.getByLabel('进程', { exact: true }).locator('option').allTextContents(),
      ['全部进程', '主进程', '主窗口', '渲染进程'],
    );
    assert.equal(
      await monitor.locator('[data-metric="cpuPercent"] header strong').textContent(),
      '40.0%',
    );
    assert.equal(await monitor.locator('[data-metric="cpuPercent"] path.weq-perf-line').count(), 2);
    await chooseFormOption(monitor.getByLabel('进程', { exact: true }), '渲染进程');
    assert.equal(
      await monitor.locator('[data-metric="cpuPercent"] header strong').textContent(),
      '20.0%',
    );
    assert.equal(await monitor.locator('[data-metric="cpuPercent"] path.weq-perf-line').count(), 2);
    await chooseFormOption(monitor.getByLabel('进程', { exact: true }), '主窗口');
    assert.ok(
      await monitor.getByLabel('进程', { exact: true }).locator('option[value="主进程"]').count(),
    );
    await monitor
      .locator('.weq-perf-chart svg')
      .first()
      .click({ position: { x: 220, y: 45 } });
    const tooltip = monitor.locator('.weq-perf-chart-tooltip').first();
    await tooltip.waitFor();
    assert.equal((await tooltip.textContent()).includes('范围'), false);
    assert.equal(
      await tooltip.locator('strong').evaluate((value) => getComputedStyle(value).gridColumnStart),
      'auto',
    );
    await monitor.getByText('同步 1.2 ms', { exact: false }).waitFor();
    await chooseFormOption(monitor.getByLabel('明细类别'), 'resources');
    await monitor.getByText('受管图片', { exact: false }).waitFor();
    if (output)
      await monitor.screenshot({ path: resolve(output, host + '-sample.png'), fullPage: true });
    await monitor.getByRole('button', { name: '关闭明细' }).click();
    await monitor.getByRole('button', { name: '放大时间轴' }).click();
    assert.equal(await monitor.getByLabel('开始时间').count(), 0);
    await monitor.getByRole('button', { name: '导出性能记录' }).click();
    await monitor.getByRole('button', { name: '图表统计 CSV' }).click();
    assert.equal(await page.evaluate(() => window.performanceQa.exports.length), 1);
    await monitor.setViewportSize({ width: 1060, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty('--weq-accent-effective', '#137a63');
      }, theme);
      await monitor.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      const colors = await monitor.locator('.weq-perf-chart').evaluateAll((charts) =>
        charts.map((chart) => {
          const stroke = getComputedStyle(chart.querySelector('path.weq-perf-line')).stroke;
          const fill = getComputedStyle(chart.querySelector('.weq-perf-area')).fill;
          const swatch = getComputedStyle(chart.querySelector('h3'), '::before').backgroundColor;
          const marker = chart.querySelector('.weq-perf-highlight');
          return {
            metric: chart.dataset.metric,
            stroke,
            fill,
            swatch,
            marker: marker ? getComputedStyle(marker).fill : null,
          };
        }),
      );
      assert.equal(colors.length, 5);
      assert.equal(new Set(colors.map((row) => row.stroke)).size, 5);
      for (const row of colors) {
        assert.equal(row.fill, row.stroke, row.metric);
        assert.equal(row.swatch, row.stroke, row.metric);
        if (row.marker) assert.equal(row.marker, row.stroke, row.metric);
      }
      if (output)
        await monitor.screenshot({
          path: resolve(output, host + '-metric-colors-' + theme + '.png'),
          fullPage: true,
        });
    }
    for (const [width, height] of [
      [1440, 900],
      [1060, 740],
      [720, 520],
      [390, 844],
      [320, 760],
    ]) {
      await monitor.setViewportSize({ width, height });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'light' ? '#006d50' : '#f5cb70',
          );
        }, theme);
        await monitor.waitForTimeout(100);
        assert.equal(
          await monitor.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await monitor.locator('.weq-perf-chart').last().scrollIntoViewIfNeeded();
        assert.equal(
          await monitor
            .locator('.weq-perf-chart')
            .last()
            .evaluate((chart) => {
              const box = chart.getBoundingClientRect();
              return chart.contains(
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
              );
            }),
          true,
        );
        await monitor.locator('.weq-perf-chart').first().scrollIntoViewIfNeeded();
        await assertCursorAlignment(monitor);
        if (output)
          await monitor.screenshot({
            path: resolve(output, host + '-' + width + '-' + theme + '.png'),
            fullPage: true,
          });
      }
    }
    await monitor.setViewportSize({ width: 1060, height: 740 });
    await monitor.getByRole('button', { name: '查看事件', exact: true }).click();
    await monitor.getByLabel('事件明细').getByText('采样中断', { exact: true }).waitFor();
    await monitor.getByRole('button', { name: '关闭明细' }).click();
    const [logs] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('button', { name: '打开日志查看' }).click(),
    ]);
    logs.on('pageerror', (error) => errors.push(error.message));
    await logs.getByText('合成日志 159', { exact: false }).waitFor();
    assert.deepEqual(await logs.evaluate(() => ({ width: innerWidth, height: innerHeight })), {
      width: 960,
      height: 680,
    });
    assert.equal(await logs.getByRole('tab').count(), 0);
    assert.equal(await logs.getByRole('button', { name: '记录设置', exact: true }).count(), 0);
    await logs.getByRole('button', { name: '选择日志文件', exact: true }).click();
    await logs.getByRole('option', { name: /2026-11-16 16:54:40.*16:57:19/ }).click();
    const popupCount = browser.contexts()[0].pages().length;
    await page.getByRole('button', { name: '打开性能监视' }).click();
    await page.getByRole('button', { name: '打开日志查看' }).click();
    assert.equal(browser.contexts()[0].pages().length, popupCount);
    assert.equal(await monitor.getByLabel('进程', { exact: true }).inputValue(), '主窗口');
    await logs.getByRole('button', { name: '跟随最新', exact: true }).click();
    if (output)
      await logs.screenshot({ path: resolve(output, host + '-logs.png'), fullPage: true });
    await page.evaluate(() => {
      window.performanceQa.setActive(false);
      window.performanceQa.requests = [];
    });
    await monitor.getByRole('button', { name: '查看事件', exact: true }).click();
    assert.ok(
      await page.evaluate(() =>
        window.performanceQa.requests.some((row) => row.route === 'history' && row.enabled),
      ),
    );
    await page.evaluate(() => {
      window.performanceQa.requests = [];
    });
    await monitor.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await monitor.waitForTimeout(100);
    await page.waitForFunction(() =>
      window.performanceQa.requests.some((row) => row.route === 'history' && !row.enabled),
    );
    assert.ok(
      await page.evaluate(() =>
        window.performanceQa.requests
          .filter((row) => ['history', 'detail'].includes(row.route))
          .every((row) => !row.enabled),
      ),
    );
    const reads = await page.evaluate(() => window.performanceQa.logReads);
    await logs.waitForTimeout(1400);
    assert.ok((await page.evaluate(() => window.performanceQa.logReads)) > reads);
    await logs.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const stopped = await page.evaluate(() => window.performanceQa.logReads);
    await logs.waitForTimeout(1400);
    assert.equal(await page.evaluate(() => window.performanceQa.logReads), stopped);
    await monitor.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await monitor.getByRole('button', { name: '关闭监视窗口' }).click();
    assert.equal(logs.isClosed(), false);
    await logs.close();
    await page.evaluate(() => window.performanceQa.setActive(true));
    await page.getByRole('button', { name: '清空性能记录历史' }).click();
    await page.getByRole('button', { name: '清空历史', exact: true }).click();
    await page.getByText('性能记录历史已清空', { exact: true }).waitFor();
  }
  for (const state of settingsOnly ? [] : ['empty', 'error']) {
    await page.goto(url + '?state=' + state);
    const [monitor] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('button', { name: '打开性能监视' }).click(),
    ]);
    await monitor
      .getByText(state === 'empty' ? '此时间范围暂无记录' : '历史读取失败：合成读取失败', {
        exact: false,
      })
      .waitFor();
    await monitor.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    settingsOnly
      ? '日志与性能：保存策略、清理确认与窄屏设置布局通过'
      : '日志与性能：配置分离、两个小型独立窗口、自动保存、现场保留、独立文档可见性、导出清空、五种尺寸的光标对齐及浅深主题通过',
  );
} finally {
  await browser?.close();
  await server.close();
}
