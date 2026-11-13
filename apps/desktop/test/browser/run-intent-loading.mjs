import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'intent-loading-'));
const output = process.env.WEQ_INTENT_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: { entries: ['test/browser/intent-loading.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'intent-loading.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [resolve(root, '../..')] } },
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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/intent-loading.html`;
  if (output) await mkdir(output, { recursive: true });
  await page.goto(url);
  await page.waitForSelector('.weq-int-profile-skeleton');
  await page.evaluate(() => window.intentQa.setMode('loading'));
  const geometry = () =>
    page.evaluate(() =>
      Object.fromEntries(
        ['.weq-intent-chips', '.weq-int-suggest', '.message-scroll', '.weq-affinity-pill'].map(
          (selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return [selector, { top: rect.top, height: rect.height, width: rect.width }];
          },
        ),
      ),
    );
  const historyAligned = () =>
    page.evaluate(() => {
      const track = document.querySelector('.weq-int-suggest-track').getBoundingClientRect();
      return [...document.querySelectorAll('.weq-int-history-replies')].every((node) => {
        const rect = node.getBoundingClientRect();
        return (
          Math.abs(rect.left - track.left) <= 1 &&
          Math.abs(rect.right - track.right) <= 1 &&
          getComputedStyle(node).scrollbarWidth === 'none'
        );
      });
    });
  const detailsBeside = (label) =>
    page.getByLabel(label, { exact: true }).evaluate(async (anchor) => {
      // 窄屏重排后等待 ResizeObserver 的锚点定位完成，不读取中间帧。
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const card = document.querySelector('.weq-int-round-details');
      const rect = card.getBoundingClientRect();
      const trigger = anchor.getBoundingClientRect();
      const close = (a, b) => Math.abs(a - b) <= 1;
      return (
        card.parentElement.classList.contains('is-anchored-popover') &&
        close(rect.left, Math.max(8, Math.min(trigger.left, innerWidth - rect.width - 8))) &&
        (close(rect.top, trigger.bottom + 8) ||
          close(rect.bottom, trigger.top - 8) ||
          close(rect.top, 8)) &&
        rect.left >= 8 &&
        rect.right <= innerWidth - 8 &&
        rect.top >= 8 &&
        rect.bottom <= innerHeight - 8
      );
    });
  const loading = await geometry();
  assert.equal(await page.getByLabel('换一批建议', { exact: true }).isDisabled(), false);
  await page.getByLabel('换一批建议', { exact: true }).hover();
  assert.equal(await page.getByLabel('停止推荐回复', { exact: true }).count(), 1);
  await page.mouse.move(0, 0);
  assert.equal(await page.locator('.weq-int-suggest-track').textContent(), '正在生成推荐回复');
  assert.equal(await page.locator('.weq-intent-pill.is-loading').count(), 2);
  if (output) await page.screenshot({ path: resolve(output, 'loading.png'), fullPage: true });
  const initialHistory = await page.evaluate(() => window.intentQa.getHistory());
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#fff3a1' : '#075c30',
        );
        document.documentElement.dataset.background = 'paper';
      }, theme);
      await page.getByLabel('查看当前推荐详情', { exact: true }).click();
      const panel = page.locator('.weq-int-round-details');
      await panel
        .getByRole('status')
        .filter({ hasText: /^等待模型返回$/ })
        .waitFor();
      assert.ok((await panel.getByRole('log').textContent()).includes('已发送推荐请求'));
      assert.equal(
        await detailsBeside('查看当前推荐详情'),
        true,
        `${width}/${theme}: 生成中详情不越界 ${JSON.stringify(await panel.evaluate((node) => ({ rect: node.getBoundingClientRect().toJSON(), viewport: [innerWidth, innerHeight] })))}`,
      );
      if (output && width !== 320)
        await page.screenshot({
          path: resolve(output, `recommendation-live-${width}-${theme}.png`),
        });
      await page.evaluate(() => window.intentQa.setMode('ready'));
      await panel
        .getByRole('status')
        .filter({ hasText: /^生成完成$/ })
        .waitFor();
      assert.ok((await panel.getByRole('log').textContent()).includes('本轮生成完成'));
      assert.ok(
        (await panel.locator('.weq-int-round-summary').textContent()).includes('双方正在聊日常'),
      );
      await page.getByLabel('关闭推荐详情', { exact: true }).click();
      await page.evaluate((entries) => {
        window.intentQa.setHistory(entries);
        window.intentQa.setMode('loading');
      }, initialHistory);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.background = 'plain';
  });
  await page.evaluate(() => {
    window.intentQa.publishResult();
    window.intentQa.publishProgress({
      total: 18,
      completed: 12,
      failed: 3,
      pendingIds: ['pending'],
    });
  });
  await page.waitForFunction(() =>
    document.querySelector('.weq-intent-chips')?.textContent.includes('闲聊'),
  );
  assert.equal(await page.locator('.weq-int-batch').count(), 0);
  assert.equal(await page.locator('[aria-label="重试分析"]').count(), 0);
  assert.deepEqual(await geometry(), loading, '批次仍在处理时结果已出现且不改变消息区几何');
  if (output) await page.screenshot({ path: resolve(output, 'partial-results.png') });
  await page.evaluate(() => window.intentQa.setMode('ready'));
  await page.waitForSelector('.weq-int-affinity-num');
  await page.waitForFunction(() =>
    document.querySelector('.weq-intent-chips')?.textContent.includes('闲聊'),
  );
  const ready = await geometry();
  assert.deepEqual(ready, loading, '加载切换到结果不改变槽位和消息区几何');
  await page.getByLabel('定位到当前推荐的最后一条输入消息', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.intentQa.located.msgSeq), '77');
  await page.getByLabel('查看当前推荐详情', { exact: true }).click();
  await page.waitForSelector('.weq-int-round-details');
  assert.equal(await detailsBeside('查看当前推荐详情'), true, '正式推荐详情应贴近点击入口');
  assert.ok(
    (await page.locator('.weq-int-round-details').textContent()).includes('fixture-chat-model'),
  );
  assert.ok(
    (await page.locator('.weq-int-round-summary').textContent()).includes('双方正在聊日常'),
  );
  await page.getByRole('button', { name: '请求日志', exact: true }).click();
  assert.ok(
    (await page.locator('.weq-int-round-log .weq-model-log').textContent()).includes('User Prompt'),
  );
  assert.equal(
    await page.locator('.weq-int-round-log .weq-model-log').evaluate((node) => node.scrollTop),
    0,
  );
  if (output) await page.screenshot({ path: resolve(output, 'recommendation-details.png') });
  await page.getByLabel('关闭推荐详情', { exact: true }).click();
  await page.locator('.weq-int-suggest-pill').first().click();
  assert.equal(await page.getByLabel('草稿').inputValue(), '有空一起聊聊');
  await page.getByLabel('展开回复历史', { exact: true }).click();
  await page.waitForSelector('.weq-int-history-row');
  const historyGeometry = await geometry();
  const historyHeight = await page
    .locator('.weq-int-history-slot')
    .evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(historyGeometry['.message-scroll'].height > ready['.message-scroll'].height / 2);
  assert.ok(historyHeight < ready['.message-scroll'].height / 2);
  assert.equal(await page.locator('.weq-int-history-row').count(), 1);
  assert.equal(await historyAligned(), true);
  assert.equal(await page.locator('.weq-int-history .lucide-lightbulb').count(), 1);
  assert.equal(
    await page
      .locator('.weq-int-history-replies')
      .evaluate((node) => getComputedStyle(node).scrollbarWidth),
    'none',
  );
  await page.getByLabel('定位到本次推荐的最后一条输入消息', { exact: true }).first().click();
  assert.equal(await page.evaluate(() => window.intentQa.located.msgSeq), '66');
  await page.getByLabel('查看本轮推荐详情', { exact: true }).click();
  await page.waitForSelector('.weq-int-round-details');
  assert.equal(await detailsBeside('查看本轮推荐详情'), true, '历史推荐详情应贴近对应日期入口');
  assert.ok((await page.locator('.weq-int-round-summary').textContent()).includes('未记录'));
  await page.getByLabel('关闭推荐详情', { exact: true }).click();
  if (output) await page.screenshot({ path: resolve(output, 'history-desktop.png') });
  await page.evaluate(() => {
    window.intentQa.setHistory(
      Array.from({ length: 30 }, (_, i) => ({
        id: `long-${30 - i}`,
        createdAt: 1794283200000 - i * 1000,
        target: {
          msgId: String(30 - i),
          msgSeq: String(30 - i),
          senderUin: '10000',
          sendTime: 1794283200 - i,
        },
        suggestions: [{ text: `历史推荐 ${30 - i}` }],
      })),
    );
  });
  await page.waitForFunction(() => document.querySelectorAll('.weq-int-history-row').length === 30);
  await page.waitForFunction(
    () =>
      Math.abs(
        document.querySelector('.weq-int-history').getBoundingClientRect().height - (34 * 3.5 + 1),
      ) <= 1,
  );
  const historyChecks = await page.locator('.weq-int-history').evaluate((node) => ({
    bottom: Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1,
    first: node.querySelector('.weq-int-history-row .weq-int-suggest-text').textContent,
    last: [...node.querySelectorAll('.weq-int-history-row .weq-int-suggest-text')].at(-1)
      .textContent,
    height: node.getBoundingClientRect().height,
  }));
  assert.equal(historyChecks.bottom, true);
  assert.equal(historyChecks.first, '历史推荐 1');
  assert.equal(historyChecks.last, '历史推荐 30');
  assert.ok(Math.abs(historyChecks.height - (34 * 3.5 + 1)) <= 1);
  assert.equal(await historyAligned(), true);
  if (output) await page.screenshot({ path: resolve(output, 'history-long.png') });
  await page.getByLabel('收起回复历史', { exact: true }).click();
  assert.deepEqual(await geometry(), ready, '收起历史恢复原消息区高度');
  await page.evaluate(() => window.intentQa.setMode('error'));
  await page.waitForSelector('.weq-int-suggest-error');
  assert.equal(await page.locator('.weq-int-affinity-num').textContent(), '70');
  assert.deepEqual(await geometry(), ready, '刷新失败不改变布局或抹掉已有画像');
  if (output) await page.screenshot({ path: resolve(output, 'refresh-error.png'), fullPage: true });
  await page.evaluate(() => {
    window.intentQa.setMode('ready');
  });

  let cases = 0;
  let minimumContrast = 100;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      for (const background of ['plain', 'paper', 'grid', 'dots', 'wash', 'telegram']) {
        for (const accent of ['#075c30', '#fff3a1']) {
          await page.evaluate(
            ({ theme, background, accent }) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.dataset.background = background;
              document.documentElement.style.setProperty('--weq-accent-effective', accent);
            },
            { theme, background, accent },
          );
          await page.evaluate(() =>
            window.intentQa.publishProgress({
              total: 18,
              completed: 18,
              failed: 3,
              pendingIds: [],
            }),
          );
          const progressFits = await page.locator('.weq-int-batch').evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const label = node.querySelector('span');
            return (
              rect.left >= 0 && rect.right <= innerWidth && label.scrollWidth <= label.clientWidth
            );
          });
          assert.equal(
            progressFits,
            true,
            `${width}/${theme}/${background}/${accent}: 进度文案应完整且不越界`,
          );
          await page.evaluate(async () => {
            window.scrollTo(0, 0);
            await new Promise(requestAnimationFrame);
            document.querySelector('.weq-intent-details').focus({ preventScroll: true });
          });
          await page.waitForSelector('.weq-intent-popover', { timeout: 5000 }).catch((error) => {
            throw new Error(`${width}/${theme}/${background}/${accent}: ${error.message}`);
          });
          const checks = await page.evaluate(() => {
            const popover = document.querySelector('.weq-intent-popover');
            const bars = [...popover.querySelectorAll('.weq-intent-popover-bar')].map((node) =>
              node.getBoundingClientRect(),
            );
            const pixels = (color) => {
              const context = document.createElement('canvas').getContext('2d');
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
              return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };
            const luminance = (rgb) =>
              rgb
                .map((v) => {
                  const s = v / 255;
                  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index], 0);
            const ratios = [
              ...document.querySelectorAll(
                '.intent-palette .weq-intent-pill, .intent-palette .weq-affinity-pill',
              ),
            ].map((node) => {
              const css = getComputedStyle(node);
              const a = luminance(pixels(css.color)),
                b = luminance(pixels(css.backgroundColor));
              return {
                ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
                text: node.textContent,
                color: css.color,
                background: css.backgroundColor,
              };
            });
            const rect = popover.getBoundingClientRect();
            return {
              sameTracks:
                Math.abs(bars[0].width - bars[1].width) < 0.1 &&
                Math.abs(bars[0].left - bars[1].left) < 0.1,
              compact:
                rect.width <= 180 &&
                [...popover.querySelectorAll('.is-metric > :first-child')].every(
                  (node) => getComputedStyle(node).whiteSpace === 'nowrap',
                ),
              noDuplicate: popover.querySelectorAll('.weq-intent-pill').length === 0,
              noActions:
                popover.querySelectorAll('button, a, [role="button"]').length === 0 &&
                !document.querySelector('button.weq-intent-details'),
              pointerTransparent: getComputedStyle(popover).pointerEvents === 'none',
              inViewport:
                rect.left >= 0 &&
                rect.right <= innerWidth &&
                document.documentElement.scrollWidth <= innerWidth,
              targets: [...document.querySelectorAll('.weq-int-suggest button')].every((node) => {
                const r = node.getBoundingClientRect();
                return r.width >= 24 && r.height >= 24;
              }),
              reducedMotion:
                getComputedStyle(document.querySelector('.weq-int-suggest-refresh svg'))
                  .animationName === 'none',
              minimumContrast: Math.min(...ratios.map((item) => item.ratio)),
              worstContrast: ratios.sort((a, b) => a.ratio - b.ratio)[0],
            };
          });
          for (const [key, value] of Object.entries(checks))
            if (!['minimumContrast', 'worstContrast'].includes(key))
              assert.equal(value, true, `${width}/${theme}/${background}/${accent}: ${key}`);
          assert.ok(
            checks.minimumContrast >= 4.5,
            `${width}/${theme}/${background}/${accent}: ${JSON.stringify(checks.worstContrast)}`,
          );
          minimumContrast = Math.min(minimumContrast, checks.minimumContrast);
          if (output && background === 'plain' && accent === '#075c30' && width !== 320)
            await page.screenshot({ path: resolve(output, `ready-${width}-${theme}.png`) });
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('.weq-intent-popover').count(), 0);
          await page.locator('.weq-intent-details').first().blur();
          if (background === 'plain' && accent === '#075c30') {
            const before = await geometry();
            await page.getByLabel('展开回复历史', { exact: true }).click();
            const expanded = await geometry();
            assert.ok(expanded['.message-scroll'].height > before['.message-scroll'].height / 2);
            assert.equal(
              await historyAligned(),
              true,
              `${width}/${theme}: 历史与正式推荐滚动区两边界对齐`,
            );
            await page.getByLabel('查看当前推荐详情', { exact: true }).click();
            assert.equal(
              await detailsBeside('查看当前推荐详情'),
              true,
              `${width}/${theme}: 推荐详情应靠近入口并避让窗口边缘`,
            );
            await page.getByRole('button', { name: '请求日志', exact: true }).click();
            const detailFits = await page.locator('.weq-int-round-details').evaluate((node) => {
              const rect = node.getBoundingClientRect();
              return (
                rect.left >= 0 &&
                rect.right <= innerWidth &&
                rect.top >= 0 &&
                rect.bottom <= innerHeight &&
                node.scrollWidth <= node.clientWidth
              );
            });
            assert.equal(detailFits, true, `${width}/${theme}: 推荐详情与长 prompt 不越界`);
            if (output && width === 390)
              await page.screenshot({
                path: resolve(output, `recommendation-details-${theme}-mobile.png`),
              });
            await page.getByLabel('关闭推荐详情', { exact: true }).click();
            if (output && width === 390)
              await page.screenshot({ path: resolve(output, `history-${width}-${theme}.png`) });
            await page.getByLabel('收起回复历史', { exact: true }).click();
          }
          cases++;
        }
      }
    }
  }
  await page.goto(`${url}?manual=1`);
  await page.evaluate(() => {
    window.intentQa.setHistory([
      {
        id: 'expired',
        createdAt: Date.now() - ((365 + 12) * 86400 + 3 * 3600) * 1000,
        target: { msgId: 'old', senderUin: '10000', sendTime: 1000 },
        suggestions: [{ text: '已过期的推荐' }],
      },
    ]);
    window.intentQa.setMode('empty');
  });
  await page.locator('.weq-int-suggest-empty').filter({ hasText: '1年12天前' }).waitFor();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#fff3a1' : '#075c30',
        );
      }, theme);
      assert.equal(await page.locator('.weq-int-suggest-pill').count(), 0);
      const notice = page.locator('.weq-int-suggest-empty');
      assert.equal(
        await notice.getAttribute('title'),
        '暂无推荐回复（距上次推荐 1年12天，已过期）',
      );
      assert.equal(
        await notice.locator('.weq-int-suggest-expired-age').evaluate((node) => {
          const track = node.closest('.weq-int-suggest-track').getBoundingClientRect();
          const rect = node.getBoundingClientRect();
          return (
            node.scrollWidth <= node.clientWidth &&
            rect.left >= track.left &&
            rect.right <= track.right
          );
        }),
        true,
        `${width}/${theme}: 距上次推荐的时间应完整可见`,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (output) await page.screenshot({ path: resolve(output, `expired-${width}-${theme}.png`) });
      cases++;
    }
  }
  await page.goto(`${url}?manual=1&animation-off=1`);
  await page.evaluate(() => {
    window.intentQa.setMode('ready');
    window.intentQa.publishResult('message');
    window.intentQa.setManualPendingMessages(['message']);
  });
  await page.waitForSelector('.weq-intent-chips[data-intent-state="pending"]');
  assert.equal(await page.locator('.weq-intent-pill.is-loading').count(), 2);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      assert.equal(await page.locator('.weq-intent-pill.is-loading').count(), 2);
      assert.equal(
        await page.locator('.weq-intent-chips').evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth;
        }),
        true,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `manual-single-${width}-${theme}.png`) });
    }
  }
  await page.evaluate(() => window.intentQa.setManualPendingMessages([]));
  await page.waitForSelector('.weq-intent-chips[data-intent-state="ready"]');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, minimumContrast, errors, geometry: ready, output }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
