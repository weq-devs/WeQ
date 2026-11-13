import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_IDENTITY_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(
    root,
    process.env.WEQ_PROFILE_IDENTITY_TOUCH
      ? 'node_modules/.vite-profile-identity-touch'
      : 'node_modules/.vite-profile-identity',
  ),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/profile-identity.stub.ts'),
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
  const page = await browser.newPage({
    hasTouch: Boolean(process.env.WEQ_PROFILE_IDENTITY_TOUCH),
  });
  const widths = process.env.WEQ_PROFILE_IDENTITY_WIDTHS?.split(',').map(Number) ?? [
    320, 390, 420, 421, 760, 800, 1180,
  ];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  const surfaces = process.env.WEQ_PROFILE_IDENTITY_POPOVER_ONLY
    ? ['popover']
    : ['embedded', 'popover'];
  let cases = 0;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark', 'system']) {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      for (const surface of surfaces) {
        for (const name of ['long', 'unbroken', 'short']) {
          const layouts = [];
          for (const variant of ['group', 'group-controls', 'friend', 'friend-controls']) {
            const kind = variant.startsWith('friend') ? 'friend' : 'group';
            const controls = variant.endsWith('-controls');
            if (controls && surface === 'embedded') continue;
            const params = new URLSearchParams();
            if (controls) params.set('controls', '');
            if (kind === 'friend') params.set('friend', '');
            if (surface === 'popover') params.set('popover', '');
            if (name !== 'long') params.set(name, '');
            await page.goto(
              `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-identity.html?${params}`,
            );
            await page.locator('.weq-profile-name').waitFor();
            await page.evaluate((theme) => {
              const store = window.profileIdentityQa.store.getState();
              store.setPreference(theme);
              store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
              store.setBackground(theme === 'light' ? 'plain' : 'grid');
            }, theme);
            const result = await page
              .locator('.weq-profile-dialog, .weq-group-card, .weq-contact-card')
              .first()
              .evaluate((dialog) => {
                const title = dialog.querySelector('.weq-profile-name');
                const avatar = dialog.querySelector('.weq-profile-avatar');
                const identity = dialog.querySelector('.weq-contact-identity');
                const hero = dialog.querySelector('.weq-profile-hero');
                const actions = identity?.querySelector('.weq-contact-identity-actions');
                const bounds = (element) => element.getBoundingClientRect();
                return {
                  clipped:
                    title.scrollWidth > title.clientWidth + 1 ||
                    title.scrollHeight > title.clientHeight + 1,
                  nowrap: getComputedStyle(title).whiteSpace === 'nowrap',
                  pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
                  dialogOverflow: dialog.scrollWidth > dialog.clientWidth + 1,
                  controlsOverlap: Array.from(
                    dialog.querySelectorAll('.weq-profile-card-controls > button'),
                  ).some((button) => {
                    const control = bounds(button);
                    const name = bounds(title);
                    return (
                      name.left < control.right + 8 &&
                      name.right > control.left - 8 &&
                      name.top < control.bottom + 8 &&
                      name.bottom > control.top - 8
                    );
                  }),
                  avatarX: bounds(avatar).x - bounds(dialog).x,
                  titleX: bounds(title).x - bounds(dialog).x,
                  heroWidth: bounds(hero).width,
                  actions: Boolean(actions),
                  actionsBelow: actions ? bounds(actions).top >= bounds(hero).bottom : null,
                  actionsOverlap: actions
                    ? bounds(actions).left < bounds(hero).right - 1 &&
                      bounds(actions).top < bounds(hero).bottom - 1
                    : false,
                };
              });
            const label = `${width}/${theme}/${surface}/${name}/${variant}`;
            assert.equal(result.clipped, false, `${label}: 名称被截断`);
            assert.equal(result.nowrap, false, `${label}: 名称不能换行`);
            assert.equal(result.pageOverflow, false, `${label}: 页面横向溢出`);
            assert.equal(result.dialogOverflow, false, `${label}: 资料横向溢出`);
            assert.equal(result.controlsOverlap, false, `${label}: 名称与右上角按钮热区重叠`);
            if (surface === 'popover') {
              if (controls) {
                await page
                  .getByRole('button', {
                    name: kind === 'group' ? '打开完整群资料' : '打开完整资料页',
                    exact: true,
                  })
                  .click();
                assert.equal(await page.evaluate(() => window.profileIdentityQa.expands), 1);
              }
              const closes = await page.evaluate(() => window.profileIdentityQa.closes);
              await page
                .getByRole('button', {
                  name: kind === 'group' ? '关闭群资料' : '关闭',
                  exact: true,
                })
                .click();
              assert.equal(await page.evaluate(() => window.profileIdentityQa.closes), closes + 1);
            }
            if (surface === 'embedded') {
              assert.equal(result.actions, true, `${label}: 未使用统一操作区`);
              assert.equal(result.actionsOverlap, false, `${label}: 操作与身份信息重叠`);
              assert.equal(result.actionsBelow, width <= 760, `${label}: 操作区换行错误`);
            }
            layouts.push(result);
            if (kind === 'friend' || surface === 'popover') {
              const title = page.locator('.weq-profile-name').first();
              assert.equal(await title.evaluate((node) => node.tagName), 'SPAN');
              assert.equal(
                await title.evaluate((node) => getComputedStyle(node).userSelect),
                'text',
              );
              await title.click();
              assert.equal(await title.getByRole('status').count(), 0);
              assert.equal(await title.getAttribute('title'), null);
              assert.equal(await page.getByRole('dialog').count(), surface === 'popover' ? 1 : 0);
            }
            await page
              .getByRole('button', {
                name: kind === 'group' ? '查看消息' : '打开会话',
                exact: true,
              })
              .click();
            assert.equal(await page.evaluate(() => window.profileIdentityQa.chats), 1);
            if (surface === 'embedded' || kind === 'group') {
              await page.getByRole('button', { name: '预览消息', exact: true }).click();
              assert.equal(await page.evaluate(() => window.profileIdentityQa.previews), 1);
            }
            if (output && name === 'long' && theme !== 'system' && [390, 1180].includes(width)) {
              await page.screenshot({ path: resolve(output, `${label.replaceAll('/', '-')}.png`) });
            }
            cases++;
          }
          if (surface === 'embedded') {
            for (const key of ['avatarX', 'titleX', 'heroWidth', 'actionsBelow']) {
              assert.equal(
                layouts[0][key],
                layouts[1][key],
                `${width}/${theme}/${name}: ${key} 不一致`,
              );
            }
          }
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
