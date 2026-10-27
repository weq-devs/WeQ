import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-clone-add-members'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/clone-conversation.stub.ts'),
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
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const [theme, width, accent, background] of [
    ['light', 1280, '#075c30', 'plain'],
    ['dark', 1280, '#fff3a1', 'grid'],
    ['light', 390, '#ffffff', 'paper'],
    ['system', 390, '#73cab8', 'dots'],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/clone-conversation.html?group`,
    );
    await page.evaluate(
      ([theme, accent, background]) => window.cloneTheme(theme, accent, background),
      [theme, accent, background],
    );
    await page.getByRole('button', { name: '克隆群聊设置', exact: true }).click();
    const pane = page.locator('.weq-conversation-settings-pane');
    const open = () => pane.getByRole('button', { name: '添加成员', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '添加成员', exact: true });
    await open();
    if (await pane.count()) throw new Error('添加弹窗仍嵌套在设置内');
    const existing = picker.getByRole('checkbox', { name: '合成好友', exact: true });
    if (!(await existing.isChecked()) || !(await existing.isDisabled()))
      throw new Error('已有成员未勾选并禁用');
    const candidate = picker.getByRole('checkbox', { name: '合成新成员', exact: true });
    await candidate.check();
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    if ((await page.evaluate(() => window.cloneRequests())).length)
      throw new Error('取消发生写操作');
    await open();
    if (await candidate.isChecked()) throw new Error('取消后保留了上次选择');
    await picker.getByLabel('搜索克隆体', { exact: true }).fill('合成新');
    await candidate.check();
    await picker.getByLabel('搜索克隆体', { exact: true }).fill('');
    const fits = await picker.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const footer = node.querySelector('footer').getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        node.scrollWidth <= node.clientWidth &&
        footer.bottom <= rect.bottom
      );
    });
    if (!fits) throw new Error(`弹窗越界：${theme}/${width}`);
    if (output)
      await page.screenshot({ path: resolve(output, `add-members-${theme}-${width}.png`) });
    await picker.getByRole('button', { name: '添加（1）', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    await open();
    if (!(await candidate.isChecked()) || !(await candidate.isDisabled()))
      throw new Error('成功添加后成员未锁定');
    if (!(await picker.getByRole('button', { name: '添加（0）', exact: true }).isDisabled()))
      throw new Error('没有新选择时仍可提交');
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    const writes = await page.evaluate(() => window.cloneRequests());
    if (
      writes.length !== 1 ||
      writes[0].name !== 'addAgentLabGroupMember' ||
      writes[0].input.groupId !== 'g' ||
      writes[0].input.personaId !== 'p2'
    )
      throw new Error('批量确认提交了错误成员');
    results.push({ theme, width, fits });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
