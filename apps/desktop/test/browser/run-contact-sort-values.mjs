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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-directory-order.html`,
  );
  const friends = page.locator('[data-kind="friends"]');
  const groups = page.locator('[data-kind="groups"]');
  for (const list of [friends, groups]) await list.getByLabel('分组依据').selectOption('none');
  const choose = async (list, sort) => {
    await list.getByLabel('排序依据').selectOption(sort);
    const dialog = page.getByRole('dialog', { name: '更新信息与线索缓存', exact: true });
    if (await dialog.count()) {
      await dialog.getByRole('radio', { name: '不更新', exact: true }).click();
      await dialog.getByRole('button', { name: '确定', exact: true }).click();
    }
  };
  const titles = (list) => list.locator('.contact-row .row-title-text').allTextContents();
  const details = (list) => list.locator('.weq-directory-sort-detail').allTextContents();
  await choose(friends, 'remark');
  assert.ok((await titles(friends)).includes('阿明'));
  const signatures = await friends.locator('.contact-card-bottom').allTextContents();
  await choose(friends, 'nick');
  assert.ok((await titles(friends)).includes('小明'));
  assert.ok(!(await titles(friends)).includes('阿明'));
  assert.deepEqual(
    new Set(await friends.locator('.contact-card-bottom').allTextContents()),
    new Set(signatures),
  );
  await choose(groups, 'remark');
  assert.ok((await titles(groups)).includes('自习组'));
  const members = await groups.locator('.row-main > span').allTextContents();
  await choose(groups, 'name');
  assert.ok((await titles(groups)).includes('学习交流'));
  assert.deepEqual(
    new Set(await groups.locator('.row-main > span').allTextContents()),
    new Set(members),
  );
  for (const sort of ['age', 'birthday']) {
    await choose(friends, sort);
    assert.ok(
      (await details(friends)).every((text) => /^\d{4}-\d{2}-\d{2} （\d+ 岁）$/.test(text)),
    );
    assert.ok((await details(friends)).includes('2005-01-15 （20 岁）'));
  }
  await choose(friends, 'uin');
  assert.deepEqual(await details(friends), ['QQ 号：10001', 'QQ 号：10002', 'QQ 号：10003']);
  await friends.getByRole('button', { name: '改为降序', exact: true }).click();
  assert.deepEqual(await details(friends), ['QQ 号：10003', 'QQ 号：10002', 'QQ 号：10001']);
  await choose(groups, 'groupCode');
  assert.deepEqual(await details(groups), ['群号：20001', '群号：20002', '群号：20003']);
  await groups.getByRole('button', { name: '改为降序', exact: true }).click();
  assert.deepEqual(await details(groups), ['群号：20003', '群号：20002', '群号：20001']);
  for (const [sort, expected] of [
    ['intimacy', '亲密度：30'],
    ['likeCount', '获赞：12,580'],
    ['level', 'QQ 等级：20'],
    ['addedAt', '添加于 2022-09-01'],
    ['commonFriends', '共同好友：12 人'],
    ['commonGroups', '共同群聊：0 个'],
  ]) {
    await choose(friends, sort);
    assert.ok((await details(friends)).includes(expected), sort);
  }
  await choose(friends, 'level');
  assert.deepEqual(await details(friends), ['QQ 等级：20', 'QQ 等级：10', 'QQ 等级读取失败']);
  assert.match(
    await friends.locator('.weq-directory-sort-detail').first().getAttribute('title'),
    /缓存已过期/,
  );
  for (const [sort, expected] of [
    ['memberCount', '3 位成员'],
    ['activityScore', '活跃度：0'],
    ['createTime', '创建于 2018-06-12'],
    ['friendCount', '群内好友：2 / 3 人'],
  ]) {
    await choose(groups, sort);
    assert.ok((await details(groups)).includes(expected), sort);
  }
  const output = process.env.WEQ_CONTACT_SORT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(
        ({ width, theme }) => {
          for (const section of document.querySelectorAll(
            '[data-kind="friends"], [data-kind="groups"]',
          ))
            section.style.width = width > 700 ? '240px' : '';
          const state = window.contactOrderQa.store.getState();
          state.setPreference(theme);
          state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          state.setBackground(theme === 'light' ? 'plain' : 'grid');
        },
        { width, theme },
      );
      await choose(friends, 'age');
      await choose(groups, 'friendCount');
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        details: [...document.querySelectorAll('.weq-directory-sort-detail')].map((element) => {
          const row = element.closest('.contact-row').getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          return {
            fits: element.scrollWidth <= element.clientWidth,
            within: rect.right <= row.right && rect.top >= row.top && rect.bottom <= row.bottom,
            text: element.textContent,
          };
        }),
      }));
      assert.equal(layout.overflow, false);
      assert.ok(
        layout.details.every((detail) => detail.fits && detail.within),
        JSON.stringify({ width, theme, layout }),
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  assert.deepEqual(errors, []);
  console.log(
    '全部好友/群聊排序值、名称与第二行保留、升降序、缓存状态及 320/390/1180px 深浅主题验证通过',
  );
} finally {
  await browser?.close();
  await server.close();
}
