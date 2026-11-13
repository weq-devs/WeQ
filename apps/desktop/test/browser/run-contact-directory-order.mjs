import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-contact-order'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/contact-directory-order.stub.ts'),
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-directory-order.html`,
  );
  const friends = page.locator('[data-kind="friends"]'),
    groups = page.locator('[data-kind="groups"]');
  const output = process.env.WEQ_CONTACT_ORDER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  if (!process.env.WEQ_SPECIAL_CARE_ONLY) {
    await friends.locator('.weq-directory-order').waitFor();
    const headers = () =>
      friends.locator('.contact-cat-header:not([hidden]) .contact-cat-name').allTextContents();
    assert.deepEqual(await headers(), ['特别关心', '我的好友']);
    await friends.getByLabel('分组依据').selectOption('birthYear');
    assert.deepEqual(await headers(), ['2007 年', '2006 年', '2005 年']);
    await friends.getByLabel('分组依据').selectOption('relation');
    assert.deepEqual(await headers(), ['特别关心', '死党', '无亲密关系']);
    await friends.getByLabel('分组依据').selectOption('location');
    assert.deepEqual(new Set(await headers()), new Set(['福建', '美国']));
    for (const basis of [
      'qq',
      'birthYear',
      'constellation',
      'gender',
      'location',
      'relation',
      'direction',
      'none',
    ]) {
      await friends.getByLabel('分组依据').selectOption(basis);
      const stale = page.getByRole('dialog', { name: '更新好友/群信息缓存', exact: true });
      if (await stale.count()) {
        await stale.getByRole('radio', { name: '不更新', exact: true }).click();
        await stale.getByRole('button', { name: '仅刷新列表', exact: true }).click();
      }
      const names = await headers();
      assert.equal(names.includes('亲密关系'), false);
      assert.equal(names.includes('特别关心'), basis === 'qq' || basis === 'relation');
    }
    await friends.getByLabel('分组依据').selectOption('none');
    assert.equal(await friends.locator('.contact-cat-header:not([hidden])').count(), 0);
    assert.equal(await friends.locator('.contact-row').count(), 3);
    await friends.getByLabel('排序依据').selectOption('age');
    assert.deepEqual(await friends.locator('.contact-row .row-title-text').allTextContents(), [
      '阿明',
      '白雪',
      '张同学',
    ]);
    await friends.getByRole('button', { name: '改为升序', exact: true }).click();
    assert.deepEqual(await friends.locator('.contact-row .row-title-text').allTextContents(), [
      '张同学',
      '白雪',
      '阿明',
    ]);
    await groups.getByLabel('分组依据').selectOption('capacity');
    assert.deepEqual(await groups.locator('.contact-cat-name').allTextContents(), [
      '200 人群',
      '500 人群',
    ]);
    await groups.getByLabel('分组依据').selectOption('none');
    assert.equal(await groups.locator('.contact-cat-header:not([hidden])').count(), 0);
    assert.equal(await groups.locator('.contact-row').count(), 3);
    const dismissRefresh = async () => {
      const dialog = page.getByRole('dialog', { name: '更新好友/群信息缓存', exact: true });
      if (await dialog.count())
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
    };
    for (const sort of ['energy', 'affinity', 'lastMessageAt']) {
      await friends.getByLabel('排序依据').selectOption(sort);
      await dismissRefresh();
      assert.deepEqual(await friends.locator('.contact-row .row-title-text').allTextContents(), [
        '白雪',
        '阿明',
        '张同学',
      ]);
    }
    await friends.getByLabel('分组依据').selectOption('school');
    await dismissRefresh();
    assert.deepEqual(new Set(await headers()), new Set(['厦门大学', '实验中学', '学校未知']));
    const school = friends.locator('.contact-cat-header').filter({ hasText: '厦门大学' });
    if ((await school.getAttribute('aria-expanded')) === 'false') await school.click();
    assert.equal(await friends.locator('.contact-row').count(), 2);
    await friends.getByLabel('分组依据').selectOption('source');
    await dismissRefresh();
    const source = friends.locator('.contact-cat-header').filter({ hasText: 'QQ 群' });
    if ((await source.getAttribute('aria-expanded')) === 'false') await source.click();
    assert.deepEqual(new Set(await headers()), new Set(['QQ 群', 'QQ 号搜索']));
    const sourceLinks = friends.getByRole('button', { name: '查看来源群名片', exact: true });
    assert.equal(await sourceLinks.count(), 2);
    if (output)
      await page.screenshot({ path: resolve(output, 'source-groups.png'), fullPage: true });
    await sourceLinks.first().click();
    const sourceDialog = page.getByRole('dialog', { name: '群资料', exact: true });
    await sourceDialog.waitFor();
    assert.ok((await sourceDialog.locator('.weq-profile-id').textContent()).includes('20001'));
    await sourceDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await friends.getByLabel('分组依据').selectOption('type');
    assert.deepEqual(await headers(), ['当前好友']);
    for (const [basis, expected] of [
      ['grade', ['群等级：0', '群等级：5', '群等级未知']],
      ['freezeState', ['正常', '已冻结', '冻结状态未知']],
    ]) {
      await groups.getByLabel('分组依据').selectOption(basis);
      await dismissRefresh();
      assert.deepEqual(await groups.locator('.contact-cat-name').allTextContents(), expected);
    }
    await groups.getByLabel('分组依据').selectOption('none');
    for (const sort of ['lastMessageAt', 'joinedAt']) {
      await groups.getByLabel('排序依据').selectOption(sort);
      await dismissRefresh();
      assert.deepEqual(await groups.locator('.contact-row .row-title-text').allTextContents(), [
        '朋友们',
        '自习组',
        '长名称群聊用于检查窄屏显示',
      ]);
    }
    await groups.getByLabel('排序依据').selectOption('lastSpokeAt');
    assert.equal(
      await groups.locator('.contact-row .row-title-text').first().textContent(),
      '自习组',
    );
    assert.equal(await page.locator('[data-kind="tasks"] .weq-exp-log').count(), 2);
    assert.equal(await page.locator('[data-kind="tasks"] .weq-exp-detail-stage').count(), 2);
    assert.equal(await page.locator('[data-kind="tasks"] details').count(), 0);
    assert.ok(
      (await page.locator('[data-kind="tasks"] .weq-exp-log-text').first().textContent()).includes(
        '阿明',
      ),
    );
    await friends.getByLabel('分组依据').selectOption('school');
    await dismissRefresh();
    await groups.getByLabel('分组依据').selectOption('grade');
    await dismissRefresh();
    for (const width of [1180, 390, 320])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((width) => {
          for (const section of document.querySelectorAll(
            '[data-kind="friends"], [data-kind="groups"]',
          ))
            section.style.width = width > 700 ? '240px' : '';
        }, width);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate((theme) => {
          const state = window.contactOrderQa.store.getState();
          state.setPreference(theme);
          state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          state.setBackground(theme === 'light' ? 'plain' : 'grid');
        }, theme);
        const layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          rows: [...document.querySelectorAll('.weq-directory-order')].map((toolbar) => {
            const labels = toolbar.querySelectorAll('label');
            const a = labels[0].getBoundingClientRect(),
              b = labels[1].getBoundingClientRect();
            return {
              sameRow: Math.abs(a.top - b.top) < 1,
              fits: toolbar.scrollWidth <= toolbar.clientWidth,
            };
          }),
        }));
        assert.equal(layout.overflow, false);
        assert.ok(layout.rows.every((row) => row.sameRow && row.fits));
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
        const refreshButton = page.getByRole('button', {
          name: '更新好友/群信息缓存',
          exact: true,
        });
        assert.equal(await refreshButton.getAttribute('title'), '更新好友/群信息缓存');
        await refreshButton.click();
        const dialog = page.getByRole('dialog', { name: '更新好友/群信息缓存', exact: true });
        await dialog.waitFor();
        await page.waitForFunction(
          () =>
            document.querySelector('[aria-label="好友/群信息缓存更新范围"] [aria-checked="true"]')
              ?.textContent === '不更新',
        );
        const bounds = await dialog.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            width: innerWidth,
            bodyInset:
              element.querySelector('.weq-dialog-body').getBoundingClientRect().left - rect.left,
          };
        });
        assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bodyInset >= 12);
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${theme}-refresh.png`) });
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
      }
    await page.getByRole('button', { name: '更新好友/群信息缓存', exact: true }).click();
    await page.getByRole('button', { name: '仅刷新列表', exact: true }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
  }
  for (const [state, description] of [
    ['pending', '正在准备在线凭据…'],
    ['unready', '在线凭据尚未就绪，特别关心未更新'],
    ['restricted', '完整功能未启用，特别关心未更新'],
    ['offline', 'QQ 未在线，特别关心未更新'],
    ['ready', '特关我的人数：3 人'],
  ]) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-directory-order.html?care=${state}`,
    );
    await friends.getByLabel('分组依据').selectOption('qq');
    const header = friends.locator('.contact-cat-header').filter({ hasText: '特别关心' });
    if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
    await friends.getByText(description, { exact: true }).waitFor();
    assert.ok(
      (await friends.locator('.contact-row .row-title-text').allTextContents()).includes('阿明'),
    );
    for (const width of [320, 1180])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          (theme) => window.contactOrderQa.store.getState().setPreference(theme),
          theme,
        );
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
        const bounds = await friends.getByText(description, { exact: true }).boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
        if (output)
          await page.screenshot({ path: resolve(output, `care-${state}-${width}-${theme}.png`) });
      }
  }
  if (!process.env.WEQ_SPECIAL_CARE_ONLY) {
    const performanceRows = [];
    for (const count of [200, 1000]) {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-directory-order.html?count=${count}`,
      );
      await friends.getByLabel('分组依据').selectOption('none');
      await page.waitForFunction(
        (count) => document.querySelectorAll('[data-kind="friends"] .contact-row').length === count,
        count,
      );
      const firstPaintMs = await page.evaluate(
        () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      );
      const measures = {};
      for (const sort of ['remark', 'energy', 'affinity', 'lastMessageAt']) {
        const samples = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          await friends.getByLabel('排序依据').selectOption(sort);
          const refresh = page.getByRole('dialog', { name: '更新好友/群信息缓存', exact: true });
          if (await refresh.count())
            await refresh.getByRole('button', { name: '取消', exact: true }).click();
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          samples.push(performance.now() - start);
          await friends.getByRole('button', { name: /改为[升降]序/ }).click();
        }
        measures[sort] = samples.sort((a, b) => a - b)[2];
      }
      const scroll = await friends
        .locator('.weq-contact-directory-scroll')
        .evaluate(async (element) => {
          const frames = [];
          let last = performance.now();
          for (let i = 0; i < 30; i++) {
            element.scrollTop += 80;
            await new Promise(requestAnimationFrame);
            const now = performance.now();
            frames.push(now - last);
            last = now;
          }
          frames.sort((a, b) => a - b);
          return {
            moved: element.scrollTop > 0,
            p95FrameMs: frames[Math.floor(frames.length * 0.95)],
          };
        });
      assert.equal(scroll.moved, true);
      performanceRows.push({ count, firstPaintMs, sortMedianMs: measures, scroll });
      if (output)
        await page.screenshot({ path: resolve(output, `directory-${count}.png`), fullPage: true });
    }
    console.log(JSON.stringify({ directoryPerformance: performanceRows }));
    if (output)
      await writeFile(
        resolve(output, 'performance.json'),
        JSON.stringify(performanceRows, null, 2),
      );
  }
  assert.deepEqual(errors, []);
  console.log(
    process.env.WEQ_SPECIAL_CARE_ONLY
      ? '特别关心五种凭据状态、保留旧名单、320/1180px 浅深主题验证通过'
      : '联系人分组、排序、不分组、刷新弹窗、特别关心凭据状态与响应式主题验证通过',
  );
} finally {
  await browser?.close();
  await server.close();
}
