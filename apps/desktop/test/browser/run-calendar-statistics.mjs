import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = resolve(root, '.artifacts/calendar-statistics');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  cacheDir: resolve(root, 'node_modules/.vite-calendar-statistics'),
  optimizeDeps: {
    entries: [resolve(root, 'test/browser/calendar-statistics.html')],
    include: ['react', 'react-dom/client'],
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/calendar-statistics.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/calendar-statistics.html`,
  );
  await page.getByRole('group', { name: '统计内容', exact: true }).waitFor();
  await page
    .getByRole('status', { exact: true })
    .filter({ hasText: '等待可用读取连接，将自动继续' })
    .waitFor();
  if ((await page.getByRole('progressbar').count()) !== 1) throw new Error('未使用单一按天数进度');
  if (
    (await page
      .getByRole('button', { name: '任务日志', exact: true })
      .getAttribute('aria-expanded')) !== 'true'
  )
    throw new Error('任务日志未默认展开');
  if (!(await page.getByRole('button', { name: '列表日期：2026-11-08', exact: true }).isVisible()))
    throw new Error('列表日期被扫描日覆盖');
  await mkdir(output, { recursive: true });
  for (const width of [1100, 390, 320])
    for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate((dark) => {
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          dark ? '#80c6a9' : '#96315f',
        );
      }, dark);
      await page.getByRole('button', { name: '暂停当月统计', exact: true }).click();
      await page.getByRole('button', { name: '继续当月统计', exact: true }).waitFor();
      await page.getByRole('button', { name: '继续当月统计', exact: true }).click();
      await page
        .getByRole('group', { name: '统计内容', exact: true })
        .getByRole('button', { name: '公众号/服务号', exact: true })
        .click();
      const option = page.getByRole('button', { name: '公众号/服务号', exact: true });
      if ((await option.getAttribute('aria-pressed')) !== 'false')
        throw new Error('组合来源不能取消');
      await option.click();
      await option.focus();
      await page.keyboard.press('Escape');
      if ((await option.getAttribute('aria-pressed')) !== 'true')
        throw new Error('Escape 清空了已记忆的统计来源');
      await page.locator('.weq-overview-calendar-row').first().click();
      if ((await page.locator('body').getAttribute('data-located')) !== 'true')
        throw new Error('定位未触发');
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          [...document.querySelectorAll('button,input,progress')].some((element) => {
            const rect = element.getBoundingClientRect();
            return rect.right > innerWidth + 1 || rect.left < -1;
          }),
      );
      if (overflow) throw new Error(`布局溢出 ${width}/${dark}`);
      await page.screenshot({
        path: resolve(output, `${width}-${dark ? 'dark' : 'light'}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: '任务日志', exact: true }).click();
      await page.getByRole('button', { name: '任务日志', exact: true }).click();
    }
  const mine = page.getByRole('button', { name: '我的设备', exact: true });
  await mine.click();
  await page.reload();
  if ((await mine.getAttribute('aria-pressed')) !== 'false') throw new Error('选择未记忆');
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/calendar-statistics.html?completed=1`,
  );
  const monthRetry = page.getByRole('button', { name: '重试当月统计', exact: true });
  await monthRetry.waitFor();
  if (!(await monthRetry.isEnabled())) throw new Error('完成后当月重试被禁用');
  const oldRow = await page.locator('.weq-overview-calendar-row').first().innerText();
  await monthRetry.click();
  await page.getByRole('button', { name: '暂停当月统计', exact: true }).waitFor();
  if ((await page.locator('.weq-overview-calendar-row').first().innerText()) !== oldRow)
    throw new Error('重试时清除了原有结果');
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/calendar-statistics.html?overview=1`,
  );
  await page.getByRole('dialog', { name: '会话日历（所有会话）', exact: true }).waitFor();
  if (await page.getByRole('group', { name: '统计内容', exact: true }).count())
    throw new Error('会话日历仍有独立的范围选择');
  await page.waitForFunction(() => Number(document.documentElement.dataset.calendarPolls) >= 2);
  const left = page.locator('.weq-overview-calendar-left');
  const right = page.locator('.weq-overview-calendar-conversations');
  if (
    (await left.getByRole('progressbar').count()) !== 1 ||
    (await right.getByRole('progressbar').count())
  )
    throw new Error('统计进度未完整移至左下');
  if (await right.getByRole('button', { name: '任务日志', exact: true }).count())
    throw new Error('右侧仍有任务日志');
  for (const width of [1100, 620, 390, 320])
    for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: dark ? 'reduce' : 'no-preference' });
      await page.evaluate((dark) => {
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        document.documentElement.dataset.background = dark ? 'grid' : 'paper';
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          dark ? '#80c6a9' : '#96315f',
        );
      }, dark);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      const state = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const grid = document.querySelector('.weq-density-calendar');
        const rows = document.querySelector('.weq-overview-calendar-rows');
        const rect = dialog.getBoundingClientRect();
        const mutations = { grid: 0, rows: 0 };
        const gridObserver = new MutationObserver((items) => {
          mutations.grid += items.length;
        });
        const rowObserver = new MutationObserver((items) => {
          mutations.rows += items.length;
        });
        gridObserver.observe(grid, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        rowObserver.observe(rows, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        window.calendarStability = {
          mutations,
          gridObserver,
          rowObserver,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          grid,
          rows,
        };
        return { polls: Number(document.documentElement.dataset.calendarPolls) };
      });
      await page.waitForFunction(
        (polls) => Number(document.documentElement.dataset.calendarPolls) >= polls + 4,
        state.polls,
      );
      const stability = await page.evaluate(() => {
        const { mutations, gridObserver, rowObserver, rect, grid, rows } = window.calendarStability;
        gridObserver.disconnect();
        rowObserver.disconnect();
        const current = document.querySelector('[role="dialog"]').getBoundingClientRect();
        return {
          mutations,
          before: rect,
          after: { x: current.x, y: current.y, width: current.width, height: current.height },
          sameNodes:
            grid === document.querySelector('.weq-density-calendar') &&
            rows === document.querySelector('.weq-overview-calendar-rows'),
          shifted: ['x', 'y', 'width', 'height'].some(
            (key) => Math.abs(current[key] - rect[key]) > 1,
          ),
          overflow:
            document.documentElement.scrollWidth > innerWidth ||
            [...document.querySelectorAll('button,input,progress')].some((element) => {
              const box = element.getBoundingClientRect();
              return box.right > innerWidth + 1 || box.left < -1;
            }),
        };
      });
      if (
        stability.mutations.grid ||
        stability.mutations.rows ||
        !stability.sameNodes ||
        stability.shifted ||
        stability.overflow
      )
        throw new Error(`日历刷新不稳定 ${width}/${dark}: ${JSON.stringify(stability)}`);
      if (width > 620) {
        const layout = await page.evaluate(() => {
          const body = document.querySelector('.weq-overview-calendar-body');
          const rows = document.querySelector('.weq-overview-calendar-rows');
          const log = document.querySelector('.weq-calendar-statistics-progress .weq-exp-log');
          const calendar = document.querySelector('.weq-density-calendar');
          const progress = document.querySelector('.weq-calendar-statistics-progress');
          const right = document.querySelector('.weq-overview-calendar-conversations');
          const bottom = body.getBoundingClientRect().bottom;
          return {
            outerScroll: body.scrollHeight > body.clientHeight + 1,
            rowsGap: bottom - rows.getBoundingClientRect().bottom,
            rightTopGap: right.getBoundingClientRect().top - body.getBoundingClientRect().top,
            rightWidthGap: right.clientWidth - rows.getBoundingClientRect().width,
            logGap: bottom - log.getBoundingClientRect().bottom,
            logHeight: log.clientHeight,
            calendarGap:
              progress.getBoundingClientRect().top - calendar.getBoundingClientRect().bottom,
          };
        });
        if (
          layout.outerScroll ||
          Math.abs(layout.rowsGap) > 2 ||
          Math.abs(layout.rightTopGap) > 2 ||
          Math.abs(layout.rightWidthGap) > 2 ||
          Math.abs(layout.logGap) > 2 ||
          layout.logHeight < 140 ||
          layout.calendarGap > 13
        )
          throw new Error(`剩余空间未填满: ${JSON.stringify(layout)}`);
      } else {
        const overlap = await page.evaluate(() => {
          const left = document
            .querySelector('.weq-overview-calendar-left')
            .getBoundingClientRect();
          const right = document
            .querySelector('.weq-overview-calendar-conversations')
            .getBoundingClientRect();
          return right.top < left.bottom + 15;
        });
        if (overlap) throw new Error(`窄屏左右两栏内容重叠: ${width}/${dark}`);
      }
      await page.screenshot({
        path: resolve(output, `overview-${width}-${dark ? 'dark' : 'light'}.png`),
        fullPage: true,
      });
    }
  for (const [view, title] of [
    ['clone', '会话日历（仅克隆会话）'],
    ['assistant', '会话日历（仅 WeQ 助手会话）'],
  ]) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/calendar-statistics.html?overview=1&view=${view}`,
    );
    await page.getByRole('dialog', { name: title, exact: true }).waitFor();
    for (const width of [1100, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => {
        const title = document.querySelector('.weq-overview-calendar h3').getBoundingClientRect();
        const action = document
          .querySelector('.weq-overview-calendar header button')
          .getBoundingClientRect();
        const sameRow = title.top < action.bottom && title.bottom > action.top;
        return (
          document.documentElement.scrollWidth > innerWidth ||
          (sameRow && title.right > action.left)
        );
      });
      if (overflow) throw new Error(`范围标题溢出或遮挡操作: ${view}/${width}`);
      await page.screenshot({
        path: resolve(output, `overview-${view}-${width}.png`),
        fullPage: true,
      });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    JSON.stringify({
      cases: 18,
      overflow: false,
      selectionRemembered: true,
      navigation: true,
      stablePolling: true,
      viewScoped: true,
      output,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
