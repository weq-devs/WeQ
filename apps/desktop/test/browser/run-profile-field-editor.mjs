import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_FIELD_QA;
const image = await readFile(resolve(root, '../../resources/brand/logo.png'));
const stub = resolve(root, 'test/browser/profile-display.stub.ts');
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
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/hooks\/useQQWriteSession$/, replacement: stub },
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
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/self-profile.html`;
  const button = (name) => page.getByRole('button', { name, exact: true });
  const labels = ['性别', '生日', '所在地', '家乡', '公司', '个人说明'];
  let cases = 0;
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(url);
      await button('编辑所在地').waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="编辑所在地展示范围"]')?.textContent === '（所有人）',
      );
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#167d67' : '#db7aa4',
        );
      }, theme);
      for (const label of labels) {
        const field = page.locator(`[data-profile-field="${label}"]`);
        await field.scrollIntoViewIfNeeded();
        const original = await field.locator('.weq-profile-data-label').evaluate((node) => {
          window.profileFieldLabel = node;
          const style = getComputedStyle(node);
          return {
            font: style.font,
            color: style.color,
            width: node.getBoundingClientRect().width,
          };
        });
        await button(`编辑${label}`).click();
        assert.equal(
          await field.locator('.weq-set-row-label').count(),
          0,
          `${label}: no replacement label`,
        );
        assert.equal(await field.locator('[role="radiogroup"]').count(), label === '性别' ? 1 : 0);
        const contentLayout = await field.evaluate((node) => {
          const inputs = node.querySelector('.weq-self-field-inputs').getBoundingClientRect();
          const actions = node.querySelector('.weq-profile-field-actions').getBoundingClientRect();
          const label = node.querySelector('.weq-profile-data-label').getBoundingClientRect();
          const scope = node.querySelector('.weq-profile-field-auxiliary').getBoundingClientRect();
          const center = (rect) => rect.top + rect.height / 2;
          return {
            gap: actions.left - inputs.right,
            centered: Math.abs(center(inputs) - center(actions)) < 1,
            labelCentered:
              Math.abs(
                center(label) -
                  center(node.querySelector('.weq-profile-field-content').getBoundingClientRect()),
              ) < 1,
            scopeCentered:
              Math.abs(center(inputs) - center(scope)) < 1 || scope.top >= inputs.bottom,
          };
        });
        assert.ok(
          contentLayout.gap >= 0 && contentLayout.gap <= 8,
          `${label}/${width}: actions beside content ${JSON.stringify(contentLayout)}`,
        );
        assert.ok(
          contentLayout.centered && contentLayout.labelCentered && contentLayout.scopeCentered,
          JSON.stringify(contentLayout),
        );
        assert.equal(
          await field
            .locator('.weq-profile-data-label')
            .evaluate((node) => node === window.profileFieldLabel),
          true,
        );
        assert.deepEqual(
          await field.locator('.weq-profile-data-label').evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              font: style.font,
              color: style.color,
              width: node.getBoundingClientRect().width,
            };
          }),
          original,
        );
        if (label === '个人说明') {
          await page
            .getByRole('textbox', { name: label, exact: true })
            .fill('第一行个人说明\n第二行保持换行');
          const writes = await page.evaluate(() => window.selfProfileQa.writes());
          await page.getByRole('textbox', { name: label, exact: true }).press('Enter');
          assert.equal(
            await page.evaluate(() => window.selfProfileQa.writes()),
            writes,
            'Enter does not submit multiline text',
          );
        }
        await button(`编辑${label}展示范围`).click();
        await field.locator('[data-display-field] [aria-checked="true"]').waitFor();
        assert.equal(await field.locator(`[aria-label="保存${label}"]`).count(), 1);
        const geometry = await field.evaluate((node) => {
          const value = node.querySelector('.weq-profile-data-value').getBoundingClientRect();
          const controls = [
            ...node.querySelectorAll(
              'input,textarea,select,.weq-profile-field-actions button,[data-display-field] [role="radio"]',
            ),
          ];
          const actions = node.querySelector('.weq-profile-field-actions').getBoundingClientRect();
          return {
            inside: controls.every((control) => {
              const r = control.getBoundingClientRect();
              return r.width > 0 && r.left >= value.left - 1 && r.right <= value.right + 1;
            }),
            actionHeights: [...node.querySelectorAll('.weq-profile-field-actions button')].map(
              (control) => control.getBoundingClientRect().height,
            ),
            actionsTogether: [...node.querySelectorAll('.weq-profile-field-actions button')].every(
              (control) => Math.abs(control.getBoundingClientRect().top - actions.top) < 1,
            ),
            overflow: [
              ...node.querySelectorAll('.weq-profile-field-content,fieldset,[data-display-field]'),
            ].some((el) => el.scrollWidth > el.clientWidth + 2),
            overflowDetails: [
              ...node.querySelectorAll(
                '.weq-profile-field-content,fieldset,[data-display-field],.weq-segmented',
              ),
            ].map((el) => ({
              class: el.className,
              w: el.clientWidth,
              sw: el.scrollWidth,
              children: [...el.children].map((child) => ({
                class: child.className,
                w: child.getBoundingClientRect().width,
                sw: child.scrollWidth,
                box: getComputedStyle(child).boxSizing,
              })),
            })),
          };
        });
        assert.equal(
          geometry.inside,
          true,
          `${width}/${theme}/${label}: ${JSON.stringify(geometry)}`,
        );
        if (geometry.overflow && output)
          await page.screenshot({ path: resolve(output, 'overflow.png') });
        assert.equal(
          geometry.overflow,
          false,
          `${width}/${theme}/${label}: ${JSON.stringify(geometry.overflowDetails)}`,
        );
        assert.deepEqual(geometry.actionHeights, [28, 28]);
        assert.equal(geometry.actionsTogether, true);
        if (output && ['生日', '所在地', '个人说明'].includes(label))
          await page.screenshot({ path: resolve(output, `${width}-${theme}-${label}.png`) });
        await page.locator('.weq-profile-workspace-body').click({ position: { x: 2, y: 2 } });
        await page.keyboard.press('Escape');
        assert.equal(
          await field.locator('[data-profile-editing]').count(),
          0,
          `${label}: Esc exits after clicking blank space`,
        );
        await page.getByRole('region', { name: '我的资料', exact: true }).waitFor();
        cases++;
      }
    }
  // 只改范围不挂载内容表单，先改范围再改内容仍共用一次保存。
  const company = page.locator('[data-profile-field="公司"]');
  const before = await page.evaluate(() => window.selfProfileQa.writes());
  await button('编辑公司展示范围').click();
  assert.equal(await company.getByRole('textbox').count(), 0);
  await company.getByRole('radio', { name: '仅好友', exact: true }).click();
  await button('保存公司').click();
  await button('编辑公司展示范围').waitFor();
  assert.equal(await button('编辑公司展示范围').textContent(), '（仅好友）');
  assert.equal(await page.evaluate(() => window.selfProfileQa.writes()), before);
  await button('编辑公司展示范围').click();
  await company.getByRole('radio', { name: '不可见', exact: true }).click();
  await button('编辑公司').click();
  assert.equal(
    await company.getByRole('radio', { name: '不可见', exact: true }).getAttribute('aria-checked'),
    'true',
  );
  await page.getByRole('textbox', { name: '公司', exact: true }).fill('合成测试的新公司');
  await page.evaluate(() => window.profileDisplayQa.mismatch(true));
  await button('保存公司').click();
  await company.getByRole('alert').waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '公司', exact: true }).inputValue(),
    '合成测试的新公司',
  );
  await page.evaluate(() => window.profileDisplayQa.mismatch(false));
  await button('保存公司').click();
  await button('编辑公司展示范围').waitFor();
  assert.equal(
    await page.evaluate(() => window.selfProfileQa.writes()),
    before + 1,
    'retry does not repeat confirmed content',
  );
  assert.equal(await button('编辑公司展示范围').textContent(), '（不可见）');
  await button('编辑公司展示范围').focus();
  await button('编辑公司展示范围').click();
  await company.getByRole('radio', { name: '所有人', exact: true }).focus();
  await page.keyboard.press('Escape');
  assert.equal(
    await button('编辑公司展示范围').evaluate((node) => document.activeElement === node),
    true,
  );
  const touch = await browser.newPage({ viewport: { width: 320, height: 850 }, hasTouch: true });
  await touch.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await touch.goto(url);
  await touch.getByRole('button', { name: '编辑所在地', exact: true }).click();
  const touchGeometry = await touch.locator('[data-profile-field="所在地"]').evaluate((node) => {
    const bounds = node.querySelector('.weq-profile-data-value').getBoundingClientRect();
    return [...node.querySelectorAll('.weq-profile-field-actions button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return (
        rect.width === 36 &&
        rect.height === 36 &&
        rect.left >= bounds.left &&
        rect.right <= bounds.right
      );
    });
  });
  assert.deepEqual(touchGeometry, [true, true]);
  await touch.close();
  await page.getByTitle('查看教育经历', { exact: true }).click();
  const education = page.getByRole('dialog', { name: '教育经历', exact: true });
  await education.waitFor();
  const rangeRow = education.locator('[data-profile-field="展示范围"]');
  assert.equal(await rangeRow.locator('.weq-self-field-display').count(), 0);
  assert.equal(await rangeRow.locator('.weq-profile-display-summary').count(), 1);
  assert.equal(await rangeRow.locator('.weq-profile-data-label').textContent(), '展示范围');
  await rangeRow.getByRole('button', { name: '编辑教育经历展示范围', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await rangeRow.locator('[role="radiogroup"]').count(), 0);
  assert.equal(await education.count(), 1, 'Esc cancels range without closing education');
  if (output) await page.screenshot({ path: resolve(output, 'education-range.png') });
  await page.getByRole('button', { name: '关闭资料详情', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      cases,
      rangeOnly: true,
      partialRetry: true,
      labelStable: true,
      touch: true,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
