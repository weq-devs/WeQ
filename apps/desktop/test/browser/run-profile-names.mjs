import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_NAMES_QA;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WEQ_BROWSER_EXECUTABLE
    ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
    : {}),
});
const errors = [];
let cases = 0;
if (output) await mkdir(output, { recursive: true });
async function checkFixture(stub, fixture, check) {
  const server = await createServer({
    configFile: false,
    root,
    cacheDir: resolve(root, `node_modules/.vite-profile-names-${fixture}`),
    optimizeDeps: { entries: [resolve(root, `test/browser/${fixture}`)] },
    plugins: [react(), tailwind()],
    define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
    resolve: {
      alias: [
        { find: /^.*\/trpc\/client$/, replacement: resolve(root, `test/browser/${stub}`) },
        {
          find: /^.*\/hooks\/useQQWriteSession$/,
          replacement: resolve(root, `test/browser/${stub}`),
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
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    await server.listen();
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/${fixture}`;
    await check(page, url);
  } finally {
    await context.close();
    await server.close();
  }
}
async function copy(page, label) {
  const button = page.getByRole('button', { name: label, exact: true });
  await button.waitFor();
  const text = await button.evaluate((node) => {
    const content = node.cloneNode(true);
    content.querySelector('[role="status"]')?.remove();
    return content.textContent;
  });
  assert.equal(await button.getAttribute('title'), label);
  assert.equal(await button.locator('svg, button').count(), 0);
  await button.click();
  await button.getByRole('status').waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
  assert.equal(await button.getByRole('status').textContent(), '已复制');
  cases++;
}
try {
  await checkFixture('contact-card.stub.ts', 'profile-inline.html', async (page, url) => {
    await page.goto(url);
    await copy(page, '复制昵称');
    await page.goto(`${url}?group`);
    await page.getByRole('button', { name: '编辑群名称', exact: true }).click();
    await page.getByRole('textbox', { name: '群名称', exact: true }).fill('统一后的群名');
    await page.getByRole('button', { name: '保存群名称', exact: true }).click();
    await page.getByRole('button', { name: '编辑群名称', exact: true }).waitFor();
    for (const role of ['owner', 'admin', 'member', 'nonmember']) {
      await page.evaluate((role) => {
        const qa = window.contactCardQa;
        qa.role = role === 'nonmember' ? 'member' : role;
        qa.inGroup = role !== 'nonmember';
        qa.online = true;
        qa.notify();
      }, role);
      if (role === 'owner' || role === 'admin') {
        assert.equal(await page.getByRole('button', { name: '复制群名', exact: true }).count(), 0);
        await page.evaluate(() => {
          window.contactCardQa.online = false;
          window.contactCardQa.notify();
        });
      }
      await copy(page, '复制群名');
    }
    for (const width of [1180, 390, 320])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'dark' ? '#47bc97' : '#c64556',
          );
        }, theme);
        await copy(page, '复制群名');
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        assert.equal(await page.locator('button button').count(), 0);
        if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      }
  });
  await checkFixture('profile-display.stub.ts', 'self-profile.html', async (page, url) => {
    for (const params of ['?other', '?other&popover', '?popover']) {
      await page.goto(`${url}${params}`);
      await copy(page, '复制昵称');
      if (output)
        await page.screenshot({ path: resolve(output, `nickname-${params.slice(1)}.png`) });
    }
    await page.goto(url);
    await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).click();
    await page.getByRole('textbox', { name: 'QQ 昵称', exact: true }).fill('新的合成昵称');
    await page.getByRole('button', { name: '保存QQ 昵称', exact: true }).click();
    await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).waitFor();
    assert.equal(await page.locator('button button').count(), 0);
    await page.evaluate(() => window.selfProfileQa.online(false));
    await copy(page, '复制昵称');
    await page.evaluate(() => window.selfProfileQa.online(true));
    await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '复制昵称', exact: true }).count(), 0);
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, writes: 'synthetic-only' }));
} finally {
  await browser.close();
}
