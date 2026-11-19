import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-disclosure-editors'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/disclosure-editors.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
const errors = [];
let cases = 0;
const signaturesOnly = process.argv.includes('--signatures');
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_DISCLOSURE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [320, 390, 1280])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.setDefaultTimeout(5000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(() => localStorage.clear());
      await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      );
      const open = async (surface) => {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/disclosure-editors.html?surface=${surface}`,
          { timeout: 60000, waitUntil: 'domcontentloaded' },
        );
        await page.waitForFunction(() => window.disclosureTheme);
        await page.evaluate((theme) => {
          const store = window.disclosureTheme.getState();
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#b5243e' : '#81c995');
          store.setBackground(theme === 'light' ? 'paper' : 'grid');
        }, theme);
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
      };
      const check = async (dialog) => {
        await dialog.waitFor();
        const bounds = await dialog.boundingBox();
        assert(
          bounds.x >= 0 &&
            bounds.y >= 0 &&
            bounds.x + bounds.width <= width + 1 &&
            bounds.y + bounds.height <= 845,
          JSON.stringify(bounds),
        );
        assert(
          await dialog.evaluate((node) => node.contains(document.activeElement)),
          '打开后焦点应进入编辑浮层',
        );
        assert(
          await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
          '编辑浮层不应横向溢出',
        );
        const inner = await dialog.locator('.weq-dialog-body').evaluate((node) => ({
          fits: node.scrollWidth <= node.clientWidth + 1 && node.scrollLeft === 0,
          width: node.clientWidth,
          scrollWidth: node.scrollWidth,
          scrollLeft: node.scrollLeft,
          overflow: [...node.querySelectorAll('*')]
            .filter(
              (child) =>
                child.getBoundingClientRect().right > node.getBoundingClientRect().right + 1,
            )
            .map((child) => ({
              tag: child.tagName,
              className: child.className,
              width: child.getBoundingClientRect().width,
              direction: getComputedStyle(child).flexDirection,
            })),
        }));
        assert(inner.fits, `编辑正文不能横向滚动或裁切标签：${JSON.stringify(inner)}`);
        assert(
          await dialog.locator('.weq-dialog-body').evaluate((node) => {
            const body = node.getBoundingClientRect();
            return [...node.querySelectorAll('.weq-set-row-label')].every((label) => {
              const box = label.getBoundingClientRect();
              return (
                box.top >= body.top - 1 &&
                box.bottom <= body.bottom + 1 &&
                box.height <= Number.parseFloat(getComputedStyle(label).lineHeight) * 2 + 1
              );
            });
          }),
          '短配置表单的字段标签应完整可见',
        );
        for (let index = 0; index < 18; index++) {
          await page.keyboard.press(index % 2 ? 'Shift+Tab' : 'Tab');
          assert(
            await dialog.evaluate((node) => node.contains(document.activeElement)),
            'Tab 不应离开编辑浮层',
          );
        }
      };
      for (const spec of [
        {
          surface: 'rkey',
          add: '导入新配置',
          edit: '编辑',
          title: '编辑配置',
          field: 'RKEY 名称',
          path: 'bootstrap.saveExternalRkeyServer',
        },
        {
          surface: 'sse',
          add: '新增推送目标',
          edit: '编辑',
          title: '编辑推送目标',
          field: 'SSE 名称',
          path: 'bootstrap.saveSsePushServer',
        },
        {
          surface: 'onebot',
          add: '新建',
          edit: '编辑 合成服务器 1',
          title: '编辑正向 WebSocket',
          field: '网络名称',
          path: 'bootstrap.saveOneBotConfig',
          // 新契约是整份配置一起提交，没有 `id`；确认改的那一行被写进
          // `networks.wsServers` 才算数。
          checkInput: (input) => {
            const names = input.config.networks.wsServers.map((server) => server.name);
            assert.ok(names.includes('编辑后的合成配置'), names.join(','));
            assert.ok(!names.includes('合成服务器 1'), names.join(','));
          },
        },
      ].filter(() => !signaturesOnly)) {
        console.log(`checking ${spec.surface} ${width} ${theme}`);
        await open(spec.surface);
        const add = page.getByRole('button', { name: spec.add, exact: true });
        await add.click();
        let dialog = page.getByRole('dialog').last();
        await check(dialog);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert(await add.evaluate((node) => node === document.activeElement));
        const edit = page.getByRole('button', { name: spec.edit, exact: true }).first();
        await edit.click();
        dialog = page.getByRole('dialog', { name: spec.title, exact: true });
        await check(dialog);
        assert.equal(
          await dialog.getByLabel(spec.field, { exact: true }).inputValue(),
          '合成服务器 1',
        );
        await dialog.getByLabel(spec.field, { exact: true }).fill('编辑后的合成配置');
        await page.keyboard.press('Escape');
        const confirm = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
        await confirm.getByRole('button', { name: '继续编辑', exact: true }).click();
        assert.equal(
          await dialog.getByLabel(spec.field, { exact: true }).inputValue(),
          '编辑后的合成配置',
        );
        await page.evaluate(() => {
          window.disclosureQa.fail = true;
        });
        await dialog.getByRole('button', { name: '保存', exact: true }).click();
        const failure = page.getByRole('dialog').last();
        await failure.getByRole('button', { name: '我知道了', exact: true }).click();
        assert.equal(
          await dialog.getByLabel(spec.field, { exact: true }).inputValue(),
          '编辑后的合成配置',
        );
        if (output)
          await page.screenshot({ path: resolve(output, `${spec.surface}-${width}-${theme}.png`) });
        await page.evaluate(() => {
          window.disclosureQa.fail = false;
        });
        await dialog.getByRole('button', { name: '保存', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        assert(await edit.evaluate((node) => node === document.activeElement));
        const call = await page.evaluate(() => window.disclosureQa.calls.at(-1));
        assert.equal(call.path, spec.path);
        if (spec.checkInput) spec.checkInput(call.input);
        else assert.equal(call.input.id, 'fixture-0');
        cases += 2;
      }
      await open('signature');
      assert.equal(await page.getByRole('button', { name: '写签名评论', exact: true }).count(), 0);
      await page.getByRole('button', { name: '评论', exact: true }).click();
      const editor = page.getByLabel('签名评论', { exact: true });
      assert(await editor.evaluate((node) => node === document.activeElement));
      assert.equal(await page.getByRole('dialog').count(), 0);
      await editor.fill('合成回复');
      await page.getByRole('button', { name: '评论', exact: true }).click();
      assert.equal(await editor.count(), 0);
      await page.getByRole('button', { name: '评论', exact: true }).click();
      assert.equal(await editor.inputValue(), '合成回复');
      const reply = page.getByRole('button', { name: '回复评论', exact: true }).first();
      await reply.click();
      const replyEditor = page.locator('.weq-qzn-comment .weq-signature-comment-editor');
      await replyEditor.waitFor();
      assert(await editor.evaluate((node) => node === document.activeElement));
      assert.equal(await editor.inputValue(), '合成回复');
      await page.getByRole('button', { name: '取消回复', exact: true }).click();
      await replyEditor.waitFor({ state: 'detached' });
      assert.equal(await editor.inputValue(), '合成回复');
      await reply.click();
      await page.evaluate(() => {
        window.disclosureQa.fail = true;
      });
      await page.getByRole('button', { name: '发送评论', exact: true }).click();
      await replyEditor.getByRole('alert').waitFor();
      assert.equal(await editor.inputValue(), '合成回复');
      await editor.fill('LongCommentWithoutSpaces'.repeat(10));
      const overflow = await page
        .locator('.weq-signature-interactions')
        .evaluate((node) =>
          [
            node,
            ...node.querySelectorAll(
              '.weq-qzn-comment, .weq-signature-comment-editor, form, textarea',
            ),
          ]
            .filter((child) => child.scrollWidth > child.clientWidth + 2)
            .map((child) => child.className),
        );
      assert.deepEqual(overflow, [], `${width}/${theme}: signature editor overflow`);
      if (output)
        await page.screenshot({ path: resolve(output, `signature-${width}-${theme}.png`) });
      await editor.fill('合成回复');
      await page.evaluate(() => {
        window.disclosureQa.fail = false;
      });
      await page.getByRole('button', { name: '发送评论', exact: true }).click();
      await replyEditor.waitFor({ state: 'detached' });
      assert.equal(await editor.inputValue(), '');
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(
        await page.getByRole('button', { name: '评论', exact: true }).getAttribute('aria-expanded'),
        'true',
      );
      const sent = await page.evaluate(() => window.disclosureQa.calls.at(-1));
      assert.equal(sent.input.replyId, 'comment-0');
      await editor.fill('合成普通评论');
      await page.getByRole('button', { name: '发送评论', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
      const rootComment = await page.evaluate(() => window.disclosureQa.calls.at(-1));
      assert.equal(rootComment.input.replyId, undefined);
      cases += 4;
      if (signaturesOnly) {
        await page.close();
        continue;
      }
      await open('permissions');
      const add = page.getByRole('button', { name: '添加到不让 ta 看我的空间', exact: true });
      await add.click();
      const dialog = page.getByRole('dialog', { name: '添加到不让 ta 看我的空间', exact: true });
      await check(dialog);
      await dialog
        .getByLabel('搜索好友或输入 QQ 号：不让 ta 看我的空间', { exact: true })
        .fill('90001');
      await page.evaluate(() => {
        window.disclosureQa.fail = true;
      });
      await dialog.getByTitle('添加 待添加好友', { exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.weq-editor-fields')?.disabled);
      assert.equal(
        await dialog
          .getByLabel('搜索好友或输入 QQ 号：不让 ta 看我的空间', { exact: true })
          .inputValue(),
        '90001',
      );
      await page.evaluate(() => {
        window.disclosureQa.fail = false;
      });
      if (output)
        await page.screenshot({ path: resolve(output, `permissions-${width}-${theme}.png`) });
      await dialog.getByTitle('添加 待添加好友', { exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert(await add.evaluate((node) => node === document.activeElement));
      const added = await page.evaluate(() => window.disclosureQa.calls.at(-1));
      assert.equal(added.input.kind, 'blocked');
      assert.equal(added.input.targetUin, '90001');
      cases++;
      await page.close();
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
