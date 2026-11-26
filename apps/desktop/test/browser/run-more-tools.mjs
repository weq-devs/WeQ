import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: 'node_modules/.vite-more-tools',
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-surfaces.stub.ts'),
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
  browser = await webkit.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/more-tools.html`;
  const swipeBack = async (selector) => {
    await page.evaluate(async (selector) => {
      const target = document.querySelector(selector);
      const dispatch = (name, x, end = false) => {
        const touch = { identifier: 1, target, clientX: x, clientY: 280 };
        const event = new Event(name, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: end ? [] : [touch] },
          changedTouches: { value: [touch] },
        });
        target.dispatchEvent(event);
      };
      dispatch('touchstart', 4);
      dispatch('touchmove', 164);
      await new Promise((resolve) => setTimeout(resolve, 150));
      dispatch('touchend', 164, true);
    }, selector);
  };
  const output = process.env.WEQ_MOBILE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const chrome = async () => {
    assert.ok(await page.locator('.weq-mobile-header').isVisible());
    assert.ok(await page.locator('.weq-mobile-tabs').isVisible());
    const bounds = await page.locator('.app-shell > .chat-main').boundingBox();
    const top = await page.locator('.weq-mobile-header').boundingBox();
    const bottom = await page.locator('.weq-mobile-tabs').boundingBox();
    assert.ok(Math.abs(bounds.y - top.y - top.height) < 1);
    assert.ok(Math.abs(bounds.y + bounds.height - bottom.y) < 1);
    assert.equal(await page.locator('.weq-mobile-navigation > .weq-mobile-more').count(), 0);
  };
  const checks = { chrome, swipeBack, output, url };
  if (!process.argv.includes('--tasks')) await checkMoreTools(page, checks);
  await checkTaskPages(page, checks);
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}

async function checkMoreTools(page, { chrome, swipeBack, output, url }) {
  await page.goto(url);
  await page.waitForSelector('.weq-mobile-more');
  const names = ['任务', '分析', '分析报告', '导出', '导出查看器', '合成聊天记录'];
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window.moreToolsQa.theme(theme), theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      await page.waitForTimeout(100);
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      if (output)
        await page.screenshot({ path: resolve(output, `more-list-${width}-${theme}.png`) });
      assert.equal(await page.locator('.weq-mobile-more .weq-workspace-menu-trigger').count(), 0);
      for (const name of ['QQ 频道', '频道私聊', 'WeQ 助手'])
        assert.equal(
          await page.locator('.weq-mobile-more').getByRole('button', { name, exact: true }).count(),
          0,
        );
      await page
        .locator('.weq-mobile-more')
        .getByRole('button', { name: '个性装扮', exact: true })
        .click();
      await page.locator('.weq-dress-dialog').waitFor();
      await chrome();
      const dressBounds = await page.locator('.weq-dress-dialog').boundingBox();
      const headerBounds = await page.locator('.weq-mobile-header').boundingBox();
      const tabsBounds = await page.locator('.weq-mobile-tabs').boundingBox();
      assert.ok(dressBounds.y >= headerBounds.y + headerBounds.height - 1);
      assert.ok(dressBounds.y + dressBounds.height <= tabsBounds.y + 1);
      if (output) await page.screenshot({ path: resolve(output, `dressup-${width}-${theme}.png`) });
      await swipeBack('.weq-workspace-page:not([hidden])');
      await page.waitForSelector('.weq-mobile-navigation > .weq-mobile-more');
      assert.equal(await page.locator('.weq-dress-dialog').count(), 0);
      for (const [name, view] of [
        ['主页', 'home'],
        ['QQ 邮箱', 'mail'],
        ['年度报告', 'annual'],
      ]) {
        await page.locator('.weq-mobile-more').getByRole('button', { name, exact: true }).click();
        await page.locator(`[data-secondary-page="${view}"]`).waitFor();
        if (view === 'mail') {
          await page.locator('.weq-mail-primary').click();
          await page.getByRole('region', { name: '写邮件', exact: true }).waitFor();
          await swipeBack('.weq-mail-composer');
          await page.locator('.weq-mail-composer').waitFor({ state: 'detached' });
          assert.ok(await page.getByRole('region', { name: 'QQ 邮箱', exact: true }).isVisible());
        }
        await swipeBack('.app-shell > .chat-main');
        await page.waitForSelector('.weq-mobile-navigation > .weq-mobile-more');
        assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
      }
      for (const name of names) {
        await page.locator('.weq-mobile-more').getByRole('button', { name, exact: true }).click();
        const modal = name === '分析报告';
        const tool = modal
          ? page.getByRole('dialog', { name, exact: true })
          : page
              .locator('.weq-workspace-page')
              .and(page.getByRole('region', { name, exact: true }));
        await tool.waitFor();
        await tool.getByText('正在加载…', { exact: true }).waitFor({ state: 'hidden' });
        if (!modal) await chrome();
        assert.equal(await page.locator('.weq-dialog-layer:not([hidden])').count(), Number(modal));
        if (output)
          await page.screenshot({
            path: resolve(output, `more-${names.indexOf(name)}-${width}-${theme}.png`),
          });
        if (modal) await page.evaluate(() => window.weqMobileNavigation.back());
        else await swipeBack('.weq-workspace-page:not([hidden])');
        await page.waitForSelector('.weq-mobile-more');
        await tool.waitFor({ state: 'hidden' });
      }
    }
  }
  await page.locator('.weq-mobile-more').getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('region', { name: '导出', exact: true }).waitFor();
  await page.locator('[data-mobile-tab="more"]').click();
  await page.waitForSelector('.weq-mobile-more');
  await page.locator('.weq-mobile-more').getByRole('button', { name: '任务', exact: true }).click();
  await page.getByRole('region', { name: '任务', exact: true }).waitFor();
  await page.locator('[data-mobile-tab="messages"]').click();
  await page.getByRole('region', { name: '任务', exact: true }).waitFor({ state: 'detached' });
  await page.locator('[data-mobile-tab="more"]').click();
  await page.locator('.weq-mobile-more').getByRole('button', { name: '分析', exact: true }).click();
  await page.getByRole('region', { name: '分析', exact: true }).waitFor();
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('.weq-mobile-more');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.weq-mobile-more').getByRole('button', { name: '任务', exact: true }).click();
  await page.getByRole('region', { name: '任务', exact: true }).waitFor();
  await chrome();
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('.weq-mobile-more');
  await page.evaluate(() => window.moreToolsQa.openChat());
  await page.locator('.app-shell-root[data-mobile-detail]').waitFor();
  await page.evaluate(() => window.moreToolsQa.openDressUp());
  await page.locator('.weq-dress-dialog').waitFor();
  await chrome();
  await page.locator('[data-mobile-tab="messages"]').click();
  await page.locator('.weq-dress-dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.weq-mobile-header').isVisible(), false);
  await page.setViewportSize({ width: 1180, height: 844 });
  await page.locator('.weq-workspace-menu-trigger:visible').click();
  assert.ok(await page.locator('.weq-dialog-layer:not([hidden]) .weq-workspace-menu').isVisible());
  assert.equal(await page.locator('.weq-workspace-page').count(), 0);
  console.log(
    'PASS: 个性装扮顶底栏与返回、更多移除频道与助手、三个次级页面与六个工具、真实邮箱写信分层侧滑、320/390 深浅色、顶底栏边界、同标签返回、跨标签关闭及系统返回',
  );
}

async function checkTaskPages(page, { chrome, swipeBack, output, url }) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${url}?tasks=1`);
  await page.locator('.weq-mobile-more').getByRole('button', { name: /^任务/ }).click();
  const taskList = page.getByRole('region', { name: '当前任务列表', exact: true });
  const taskDetail = page.getByRole('region', { name: '任务详情', exact: true });
  await taskList.waitFor();
  assert.equal(await taskDetail.count(), 0);
  await chrome();
  if (output) await page.screenshot({ path: resolve(output, 'tasks-portrait-list.png') });
  const runningTask = taskList.getByRole('button', { name: /合成聊天 0\b/ });
  const finishedTask = taskList.getByRole('button', { name: /合成聊天 16\b/ });
  assert.equal(await finishedTask.getByRole('progressbar').count(), 0);
  await runningTask.click();
  await taskDetail.waitFor();
  assert.equal(await taskList.count(), 0);
  assert.equal(await page.locator('.weq-mobile-header').isVisible(), false);
  assert.equal(await page.locator('.weq-mobile-tabs').isVisible(), false);
  assert.ok(await taskDetail.getByRole('button', { name: '暂停', exact: true }).isVisible());
  assert.ok(await taskDetail.getByText('合成当前步骤', { exact: true }).isVisible());
  assert.equal(await taskDetail.getByText('合成已完步骤', { exact: true }).isVisible(), false);
  if (output) await page.screenshot({ path: resolve(output, 'tasks-portrait-detail.png') });
  await taskDetail.getByText(/已完成或跳过/).click();
  assert.ok(await taskDetail.getByText('合成已完步骤', { exact: true }).isVisible());
  await taskDetail.getByRole('button', { name: '返回当前任务', exact: true }).click();
  await taskList.waitFor();
  await chrome();
  assert.equal(await taskList.getByRole('button', { name: '已结束任务操作' }).count(), 0);
  await page.getByText('已归档任务', { exact: true }).click();
  const archive = page.getByLabel('已归档任务列表', { exact: true });
  await archive.getByRole('button', { name: /合成聊天 17\b/ }).click();
  await taskDetail.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '恢复到当前任务', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: '彻底删除', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page
    .getByRole('menuitem', { name: '彻底删除', exact: true })
    .waitFor({ state: 'detached' });
  await taskDetail.getByRole('button', { name: '返回已归档任务', exact: true }).click();
  await page.getByText('当前任务', { exact: true }).click();
  await taskList.waitFor();
  await finishedTask.scrollIntoViewIfNeeded();
  const scrollTop = await taskList.evaluate((node) => node.scrollTop);
  assert.ok(scrollTop > 210);
  await finishedTask.click();
  await taskDetail.waitFor();
  await taskDetail.getByRole('button', { name: '保存结果', exact: true }).click();
  await page.getByRole('region', { name: '保存结果', exact: true }).waitFor();
  await page.evaluate(() => window.weqMobileNavigation.back());
  await taskDetail.getByRole('button', { name: '保存结果', exact: true }).waitFor();
  await swipeBack('.weq-task-detail-page');
  await taskList.waitFor();
  await page.waitForFunction(
    (top) => Math.abs(document.querySelector('.weq-current-tasks').scrollTop - top) < 1,
    scrollTop,
  );
  await page.getByText('定时任务', { exact: true }).click();
  await page.getByRole('button', { name: /合成定时计划/ }).click();
  const scheduleDetail = page.getByRole('region', { name: '计划详情', exact: true });
  await scheduleDetail.getByRole('textbox', { name: '任务名称' }).waitFor();
  assert.equal(await page.locator('.weq-exp-sched-list').count(), 0);
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.getByRole('button', { name: /合成定时计划/ }).waitFor();
  await page.evaluate(() => window.moreToolsQa.focusTask('export-fixture-0'));
  await taskDetail.getByText('合成当前步骤', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1180, height: 844 });
  await page.locator('.weq-current-task-details').waitFor();
  assert.ok(await page.locator('.weq-current-task-list').isVisible());

  console.log('PASS: 竖屏任务列表/详情、已归档任务、滚动恢复、定时任务、通知直达及宽屏双栏');
}
