import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_SELF_PROFILE_QA;
const image = await readFile(resolve(root, '../../resources/brand/logo.png'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-self-profile'),
  plugins: [
    react(),
    tailwind(),
    {
      name: 'synthetic-avatars',
      configureServer(server) {
        server.middlewares.use('/_avatar/', (_req, res) => {
          res.setHeader('Content-Type', 'image/png');
          res.end(image);
        });
      },
    },
  ],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/profile-display.stub.ts'),
      },
      {
        find: /^.*\/hooks\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/profile-display.stub.ts'),
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
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/self-profile.html`;
  await page.goto(url);
  await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).waitFor();
  const nickname = page.getByRole('button', { name: '编辑QQ 昵称', exact: true });
  assert.equal(await nickname.textContent(), '合成名片昵称');
  assert.equal(await nickname.locator('svg').count(), 0);
  assert.equal(await nickname.locator('button').count(), 0);
  assert.equal(await page.locator('button button').count(), 0, '字段内没有嵌套操作按钮');
  assert.equal(await page.getByRole('button', { name: '更换头像', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '历史头像', exact: true }).count(), 1);
  assert.equal(
    await page.getByRole('button', { name: '历史头像', exact: true }).getAttribute('class'),
    'weq-profile-avatar',
    '头像本身是历史入口，不新增独立按钮',
  );
  assert.equal(await page.getByText('编辑资料与展示设置', { exact: true }).count(), 0);
  assert.equal(await page.locator('[data-profile-display-mode]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '复制昵称', exact: true }).count(), 0);
  assert.equal(await page.getByTitle('查看教育经历', { exact: true }).count(), 1);
  assert.equal(
    await page.locator('button button').count(),
    0,
    'identity and history actions are not nested',
  );
  await page.getByRole('button', { name: '查看个性签名', exact: true }).click();
  await page.getByRole('dialog', { name: '个性签名', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '个性签名', exact: true }).count(), 1);
  assert.equal(await page.getByRole('textbox', { name: '个性签名', exact: true }).inputValue(), '');
  assert.equal(
    await page.getByRole('textbox', { name: '个性签名', exact: true }).getAttribute('placeholder'),
    '新签名',
  );
  assert.equal(
    await page
      .getByRole('button', { name: '保存个性签名', exact: true })
      .locator('.lucide-check')
      .count(),
    1,
  );
  await page.getByRole('textbox', { name: '个性签名', exact: true }).fill('从资料页提交的新签名');
  await page.evaluate(() => window.selfProfileQa.failSave(true));
  await page.getByRole('button', { name: '保存个性签名', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: '个性签名', exact: true }).inputValue(),
    '从资料页提交的新签名',
  );
  await page.evaluate(() => window.selfProfileQa.failSave(false));
  await page.getByRole('button', { name: '保存个性签名', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="个性签名"]')?.value === '',
  );
  await page.getByRole('button', { name: '关闭资料详情', exact: true }).click();
  await page.getByTitle('查看教育经历', { exact: true }).click();
  await page.getByRole('dialog', { name: '教育经历', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '编辑学校', exact: true }).count(), 0);
  await page.getByRole('button', { name: '关闭资料详情', exact: true }).click();
  for (const label of ['性别', '生日', '所在地', '家乡', '邮箱', '职业', '公司', '个人说明'])
    assert.equal(
      await page.getByRole('button', { name: `编辑${label}`, exact: true }).count(),
      1,
      `${label} appears once`,
    );
  assert.equal(
    await page.evaluate(() => window.selfProfileQa.requests()),
    0,
    'no eager history query',
  );
  await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).click();
  await page.getByRole('textbox', { name: 'QQ 昵称', exact: true }).fill('新的合成昵称');
  await page.evaluate(() => window.selfProfileQa.failSave(true));
  await page.getByRole('button', { name: '保存QQ 昵称', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: 'QQ 昵称', exact: true }).inputValue(),
    '新的合成昵称',
  );
  await page.getByRole('button', { name: '取消编辑QQ 昵称', exact: true }).click();
  await page.evaluate(() => window.selfProfileQa.failSave(false));
  await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: 'QQ 昵称', exact: true }).inputValue(),
    '合成名片昵称',
  );
  await page.getByRole('textbox', { name: 'QQ 昵称', exact: true }).fill('已保存合成昵称');
  await page.getByRole('button', { name: '保存QQ 昵称', exact: true }).click();
  await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑公司', exact: true }).click();
  await page.locator('[data-display-field="company"] [aria-checked="true"]').waitFor();
  const companyRange = page.locator('[data-display-field="company"]');
  await companyRange.getByRole('radio', { name: '仅好友', exact: true }).click();
  assert.equal(await page.evaluate(() => window.profileDisplayQa.writes()), 0);
  await page.getByRole('textbox', { name: '公司', exact: true }).fill('');
  await page.getByRole('button', { name: '保存公司', exact: true }).click();
  await page.getByRole('button', { name: '编辑公司', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.profileDisplayQa.writes()), 1);
  assert.equal(await page.locator('[data-display-field]').count(), 0);
  await page.getByRole('button', { name: '编辑公司', exact: true }).click();
  await page.getByRole('textbox', { name: '公司', exact: true }).fill('只提交一次的公司');
  await page
    .locator('[data-display-field="company"]')
    .getByRole('radio', { name: '不可见', exact: true })
    .click();
  await page.evaluate(() => window.profileDisplayQa.mismatch(true));
  const beforePartial = await page.evaluate(() => window.selfProfileQa.writes());
  await page.getByRole('button', { name: '保存公司', exact: true }).click();
  await page.getByText('展示范围尚未保存。请重试保存或重新读取。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.selfProfileQa.writes()), beforePartial + 1);
  await page.evaluate(() => window.profileDisplayQa.mismatch(false));
  await page.getByRole('button', { name: '保存公司', exact: true }).click();
  await page.getByRole('button', { name: '编辑公司', exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.selfProfileQa.writes()),
    beforePartial + 1,
    'retry does not submit confirmed content again',
  );
  await page.getByRole('button', { name: '编辑个人说明', exact: true }).click();
  await page
    .getByRole('textbox', { name: '个人说明', exact: true })
    .fill('多行个人说明\n保留换行后的第二行');
  await page.getByRole('button', { name: '保存个人说明', exact: true }).click();
  await page.getByRole('button', { name: '编辑个人说明', exact: true }).waitFor();
  await page.getByText('多行个人说明', { exact: false }).waitFor();
  const results = [];
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#167d67' : '#db7aa4',
        );
        document.querySelector('.weq-profile-workspace-body').scrollTop = 0;
        document.querySelector('.weq-profile-page-header').scrollTop = 0;
      }, theme);
      const overflow = () =>
        page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '.weq-self-profile-page, .weq-self-field-display, .weq-avatar-history-dialog, .weq-avatar-history-grid article',
            ),
          ]
            .filter((el) => el.scrollWidth > el.clientWidth + 2)
            .map((el) => el.className),
        );
      assert.deepEqual(await overflow(), [], `${width}/${theme}: card overflow`);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-card.png`) });
      await page.getByRole('button', { name: '查看个性签名', exact: true }).click();
      const signatureDialog = page.getByRole('dialog', { name: '个性签名', exact: true });
      await signatureDialog.waitFor();
      assert.equal(await signatureDialog.locator('input[aria-label="个性签名"]').count(), 1);
      assert.equal(
        await signatureDialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
        true,
        `${width}/${theme}: signature editor overflow`,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}-signature.png`) });
      await page.getByRole('button', { name: '关闭资料详情', exact: true }).click();
      await page.getByRole('button', { name: '历史头像', exact: true }).click();
      await page.getByText('共 4 个头像', { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('dialog', { name: '历史头像', exact: true })
          .getByRole('button', { name: '更换头像', exact: true })
          .isEnabled(),
        true,
      );
      const dates = () => page.locator('.weq-avatar-history-grid article dl').allTextContents();
      assert.ok((await dates())[0].includes('2001'));
      await page.getByRole('radio', { name: '最早使用时间', exact: true }).click();
      assert.ok((await dates())[0].includes('2020'));
      await page.getByRole('button', { name: '改为从旧到新', exact: true }).click();
      assert.ok((await dates())[0].includes('1998'));
      assert.deepEqual(await overflow(), [], `${width}/${theme}: history overflow`);
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.weq-avatar-history-grid img')].every(
          (img) => img.complete && img.naturalWidth > 1,
        ),
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-history.png`) });
      await page.locator('.weq-avatar-history-image').first().click();
      await page.waitForFunction(() => {
        const img = document.querySelector('.weq-unified-preview img');
        return img?.complete && img.naturalWidth > 1;
      });
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Escape');
      await page.locator('.weq-unified-preview').waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('button', { name: '关闭历史头像' }).count(), 1);
      await page.getByRole('button', { name: '关闭历史头像' }).click();
      results.push({
        width,
        theme,
        overflow: false,
        sort: true,
        imageDecoded: true,
        escapeOnlyTop: true,
      });
    }
  // 暂不可写时仍允许从头像打开历史，并预览已加载图片。
  for (const state of ['offline', 'busy']) {
    await page.evaluate((state) => {
      window.selfProfileQa.online(state !== 'offline');
      window.selfProfileQa.busy(state === 'busy');
    }, state);
    const trigger = page.getByRole('button', { name: '历史头像', exact: true });
    assert.equal(await trigger.isEnabled(), true);
    await trigger.click();
    assert.equal(
      await page.getByRole('button', { name: '更换头像', exact: true }).isDisabled(),
      true,
    );
    await page.locator('.weq-avatar-history-image').first().click();
    await page.locator('.weq-unified-preview').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '关闭历史头像' }).click();
  }
  await page.evaluate(() => {
    window.selfProfileQa.online(true);
    window.selfProfileQa.busy(false);
  });
  await page.getByRole('button', { name: '历史头像', exact: true }).click();
  await page.evaluate(() => window.selfProfileQa.failHistory());
  await page.getByRole('button', { name: '重试', exact: true }).waitFor();
  assert.equal(await page.locator('.weq-avatar-history-grid article').count(), 2);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByText('共 4 个头像', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭历史头像' }).click();
  const count = await page.evaluate(() => window.selfProfileQa.requests());
  await page.waitForTimeout(1400);
  assert.equal(
    await page.evaluate(() => window.selfProfileQa.requests()),
    count,
    'closing stops pagination',
  );
  await page.goto(`${url}?popover`);
  await page.getByRole('dialog', { name: '用户资料', exact: true }).waitFor();
  assert.equal(
    await page.locator('.weq-self-field').count(),
    0,
    'compact self card stays read-only',
  );
  await page.getByRole('button', { name: '历史头像', exact: true }).click();
  const avatarDialog = page.getByRole('dialog', { name: '历史头像', exact: true });
  await avatarDialog.waitFor();
  const chooserPromise = page.waitForEvent('filechooser');
  await avatarDialog.getByRole('button', { name: '更换头像', exact: true }).click();
  await (await chooserPromise).setFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: image,
  });
  await page.waitForFunction(() => window.selfProfileQa.avatarRefreshes() === 1);
  assert.deepEqual(await page.evaluate(() => window.selfProfileQa.avatarSources()), [
    '/synthetic/new-avatar.png',
  ]);
  await page.getByRole('button', { name: '关闭历史头像' }).click();
  await page.getByRole('button', { name: '查看个性签名', exact: true }).click();
  await page.getByRole('dialog', { name: '个性签名', exact: true }).waitFor();
  assert.equal(await page.getByPlaceholder('新签名', { exact: true }).inputValue(), '');
  assert.equal(
    await page
      .getByRole('button', { name: '保存个性签名', exact: true })
      .locator('.lucide-check')
      .count(),
    1,
  );
  await page.getByPlaceholder('新签名', { exact: true }).fill('从名片提交的新签名');
  await page.getByRole('button', { name: '保存个性签名', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="个性签名"]')?.value === '',
  );
  await page.goto(`${url}?member`);
  await page.getByRole('dialog', { name: '用户资料', exact: true }).waitFor();
  await page.getByRole('button', { name: '历史头像', exact: true }).click();
  await page.getByRole('dialog', { name: '历史头像', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '更换头像', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '关闭历史头像' }).click();
  await page.goto(`${url}?other`);
  await page.getByRole('region', { name: '联系人资料', exact: true }).waitFor();
  assert.equal(await page.locator('.weq-self-field').count(), 0, 'other profiles stay read-only');
  assert.equal(await page.getByRole('button', { name: '历史头像', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '查看头像', exact: true }).count(), 1);
  await page.getByRole('button', { name: '查看个性签名', exact: true }).click();
  await page.getByRole('dialog', { name: '个性签名', exact: true }).waitFor();
  assert.equal(
    await page.getByPlaceholder('新签名', { exact: true }).count(),
    0,
    'other contacts do not get a signature composer',
  );
  assert.equal(
    await page
      .locator('[aria-label^="复制"]')
      .evaluateAll((buttons) =>
        buttons.every(
          (button) => !button.querySelector('svg, button') && Boolean(button.textContent?.trim()),
        ),
      ),
    true,
    '只读字段直接点击内容复制，不额外显示复制图标或嵌套按钮',
  );
  assert.deepEqual(errors, []);
  if (output)
    await writeFile(
      resolve(output, 'result.json'),
      JSON.stringify({ results, errors, failureRetry: true, writes: 'synthetic-only' }, null, 2),
    );
  console.log(JSON.stringify({ cases: results.length, failureRetry: true, errors }));
} finally {
  await browser?.close();
  await server.close();
}
