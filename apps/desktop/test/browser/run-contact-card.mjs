import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stub = resolve(root, 'test/browser/contact-card.stub.ts');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_CONTACT_CARD_QA;
const baseline = process.env.WEQ_CONTACT_CARD_BASELINE === '1';
const originals = [
  'components/MemberProfileCard.tsx',
  'components/qq-actions/ProfileLikesRow.tsx',
  'hooks/useCardDisplayNames.ts',
];
const server = await createServer({
  configFile: false,
  root,
  plugins: [
    react(),
    tailwind(),
    {
      name: 'contact-card-fixture',
      load(id) {
        const local = originals.find((name) => id === resolve(root, 'src/renderer/src', name));
        if (baseline && local)
          return execFileSync('git', ['show', `f48bf7ab:apps/desktop/src/renderer/src/${local}`], {
            cwd: root,
            encoding: 'utf8',
          });
      },
      configureServer(server) {
        server.middlewares.use('/resources/qqlevel', async (req, res) => {
          const name = (req.url ?? '').split('?')[0];
          if (!/^\/[a-z]+\.png$/.test(name)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          try {
            res.setHeader('content-type', 'image/png');
            res.end(await readFile(resolve(root, '../../resources/qqlevel', name.slice(1))));
          } catch {
            res.statusCode = 404;
            res.end();
          }
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
const report = [];
async function checkPrivileges(scope) {
  const icons = scope.locator('.weq-profile-privileges img');
  assert.equal(await icons.count(), 2);
  await icons.first().scrollIntoViewIfNeeded();
  await icons.evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  const sizes = await icons.evaluateAll((images) =>
    images.map((image) => {
      const bounds = image.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        fit: getComputedStyle(image).objectFit,
      };
    }),
  );
  assert.deepEqual(
    sizes.map(({ naturalWidth, naturalHeight }) => [naturalWidth, naturalHeight]),
    [
      [512, 512],
      [640, 128],
    ],
  );
  assert.ok(
    sizes.every(({ width, height, fit }) => width === 22 && height === 22 && fit === 'contain'),
    `特权图标应限制在 22px 内并保持图片比例: ${JSON.stringify(sizes)}`,
  );
  const alignment = await icons.first().evaluate((image) => {
    const value = image.closest('.weq-profile-data-value').getBoundingClientRect();
    const bounds = image.getBoundingClientRect();
    return { left: bounds.left - value.left, top: bounds.top - value.top };
  });
  assert.deepEqual(alignment, { left: 0, top: 0 }, '特权图标应与其他字段值左对齐且无顶部偏移');
  const centerOffset = await icons.first().evaluate((image) => {
    const row = image.closest('.weq-profile-data-row');
    const label = row.querySelector('.weq-profile-data-label').getBoundingClientRect();
    const privileges = image.parentElement.getBoundingClientRect();
    return Math.abs(label.top + label.height / 2 - (privileges.top + privileges.height / 2));
  });
  assert.ok(centerOffset < 0.5, `特权图标应与字段名垂直居中，实际偏移 ${centerOffset}px`);
}
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
  await page.route('**/_avatar/fetch?*', async (route) => {
    const src = new URL(route.request().url()).searchParams.get('src');
    if (!src?.startsWith('https://fixture.invalid/privilege-')) return route.abort();
    const wide = src.endsWith('privilege-wide.png');
    const body = await sharp({
      create: {
        width: wide ? 640 : 512,
        height: wide ? 128 : 512,
        channels: 4,
        background: '#cf304b',
      },
    })
      .png()
      .toBuffer();
    await route.fulfill({ contentType: 'image/png', body });
  });
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-card.html`;
  await page.goto(`${url}?slow=1`);
  await page.locator('.weq-member-pop').waitFor();
  await page.getByText('林同学', { exact: true }).waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const firstPaint = await page.locator('.weq-profile-name').evaluate((node) => ({
    text: node.textContent,
    width: node.getBoundingClientRect().width,
    pending: window.contactCardQa.pendingProfiles,
  }));
  assert.ok(firstPaint.width > 0 && firstPaint.pending > 0);
  report.push({ kind: 'first-paint', calls: [], evidence: firstPaint });
  if (output)
    await page.screenshot({
      path: resolve(output, `${baseline ? 'baseline' : 'current'}-first-paint.png`),
    });
  await page.waitForFunction(() => window.contactCardQa.pendingProfiles === 0);
  await page.waitForTimeout(300);
  const cold = await page.evaluate(() => window.contactCardQa.calls);
  report.push({ kind: baseline ? 'baseline' : 'cold', calls: cold });
  if (!baseline) {
    const card = page.locator('.weq-contact-card');
    assert.match(await card.locator('.weq-contact-title-line').innerText(), /正在听音乐/);
    assert.match(
      await card.locator('.weq-contact-identity-body').innerText(),
      /QQ\s+10002.*QID\s+sample-person/s,
    );
    assert.deepEqual(
      await card.locator('.weq-contact-identity-body .weq-profile-data-label').allTextContents(),
      ['备注', 'QQ', 'QID', '个性签名'],
    );
    assert.equal(await card.locator('.weq-contact-meta .weq-contact-number').count(), 0);
    assert.equal(await card.locator('.weq-contact-signature').count(), 1);
    assert.equal(
      await card.locator('[data-profile-field="qid"], [data-profile-field="status"]').count(),
      0,
    );
    assert.equal(
      await card.locator('[data-profile-field="birthday"] .weq-profile-data-label svg').count(),
      0,
    );
    assert.equal(await card.locator('.weq-profile-data-label svg').count(), 0);
    const levelSection = card
      .locator('.weq-profile-section-block')
      .filter({ has: page.getByText('QQ 等级', { exact: true }) });
    assert.equal(await levelSection.locator('h3').innerText(), 'QQ 账号');
    for (const [field, section] of [
      ['company', '个人资料'],
      ['labels', '个性展示'],
      ['privileges', 'QQ 账号'],
      ['common', '与我的关系'],
    ]) {
      assert.equal(
        await card
          .locator('.weq-profile-section-block')
          .filter({ has: page.locator(`[data-profile-field="${field}"]`) })
          .locator('h3')
          .innerText(),
        section,
      );
    }
    assert.equal(
      await card.locator('[data-profile-field="common"] .weq-profile-data-row').count(),
      2,
    );
    const identityRows = card.locator('.weq-contact-identity-body .weq-profile-data-row');
    const accountRows = levelSection.locator('.weq-profile-data-row');
    const rowFormat = (node) => {
      const style = getComputedStyle(node);
      return [style.gridTemplateColumns, style.fontSize, style.minHeight, style.paddingBlock];
    };
    assert.deepEqual(
      await identityRows.first().evaluate(rowFormat),
      await accountRows.first().evaluate(rowFormat),
    );
    await page.context().grantPermissions(['clipboard-write', 'clipboard-read']);
    await card.getByTitle('复制 QQ 号码', { exact: true }).click();
    await card.locator('.weq-copy-feedback').waitFor();
    assert.equal(
      await card
        .locator('.weq-copy-feedback')
        .evaluate((node) => getComputedStyle(node).animationName),
      'weq-copy-fade',
    );
    assert.ok(
      await card.locator('.weq-copy-feedback').evaluate((node) => {
        const animation = node.getAnimations()[0];
        animation.pause();
        animation.currentTime = 1650;
        const opacity = Number.parseFloat(getComputedStyle(node).opacity);
        animation.play();
        return opacity > 0 && opacity < 0.5;
      }),
    );
    await card.locator('.weq-copy-feedback').waitFor({ state: 'detached' });
    await card.getByTitle('复制邮箱', { exact: true }).click();
    await card.locator('.weq-copy-feedback').waitFor();
    const emailBounds = await card.getByTitle('复制邮箱', { exact: true }).boundingBox();
    const emailFeedbackBounds = await card.locator('.weq-copy-feedback').boundingBox();
    assert.ok(emailFeedbackBounds.y + emailFeedbackBounds.height <= emailBounds.y + 1);
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      'sample@example.invalid',
    );
    if (output) await page.screenshot({ path: resolve(output, 'copy-feedback-email.png') });
    await card.locator('.weq-copy-feedback').waitFor({ state: 'detached' });
    const previousSettings = await page.evaluate(() => {
      const qa = window.contactCardQa;
      const previous = qa.settings;
      qa.configure({ ...previous, visible: { ...previous.visible, uid: true } });
      return previous;
    });
    await card.getByTitle('复制 UID', { exact: true }).click();
    assert.deepEqual(
      await card.locator('.weq-contact-identity-body .weq-profile-data-label').allTextContents(),
      ['备注', 'QQ', 'QID', 'UID', '个性签名'],
    );
    await card.locator('.weq-copy-feedback').waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'u_sample');
    await card.locator('.weq-copy-feedback').waitFor({ state: 'detached' });
    if (output) {
      await card.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({ path: resolve(output, 'identity-five-rows.png') });
    }
    await page.evaluate((settings) => window.contactCardQa.configure(settings), previousSettings);
    const signature = card.locator('.weq-contact-signature');
    await signature.getByRole('button', { name: '展开' }).click();
    assert.equal(
      await signature
        .locator('.weq-contact-signature-text')
        .evaluate((node) => node.scrollHeight > node.clientHeight + 1),
      false,
    );
    await signature.getByRole('button', { name: '收起' }).click();
    const signatureSettings = await page.evaluate(() => {
      const previous = window.contactCardQa.settings;
      window.contactCardQa.configure({
        ...previous,
        visible: { ...previous.visible, signature: false, signatureUpdated: true },
      });
      return previous;
    });
    await signature.locator('.weq-contact-signature-time').waitFor();
    assert.equal(await signature.locator('button').count(), 0);
    assert.equal(await card.locator('[data-profile-field="signatureUpdated"]').count(), 0);
    await page.evaluate((settings) => window.contactCardQa.configure(settings), signatureSettings);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        if (output) {
          await card.evaluate((node) => {
            node.scrollTop = 0;
          });
          await page.screenshot({ path: resolve(output, `${theme}-${width}-identity.png`) });
        }
        assert.equal(await card.getByRole('navigation', { name: '更多资料' }).count(), 0);
        assert.equal(await card.locator('.weq-contact-more').count(), 0);
        assert.equal(await card.locator('.weq-contact-overflow').count(), 0);
        assert.deepEqual(await card.locator('.weq-contact-actions > button').allTextContents(), [
          '打开会话',
          '预览消息',
          '本群发言',
          '查看空间',
          '聊天分析',
        ]);
        await checkPrivileges(card);
        const layout = await card.locator('.weq-contact-actions > button').evaluateAll((buttons) =>
          buttons.map((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            const icon = node.querySelector('svg').getBoundingClientRect();
            return {
              direction: style.flexDirection,
              height: rect.height,
              appearance: {
                background: style.backgroundColor,
                border: style.border,
                radius: style.borderRadius,
                color: style.color,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                padding: style.padding,
                width: rect.width,
                height: rect.height,
              },
              fits:
                rect.left >= node.parentElement.getBoundingClientRect().left &&
                rect.right <= node.parentElement.getBoundingClientRect().right &&
                node.scrollWidth <= node.clientWidth,
              centered: Math.abs(icon.top + icon.height / 2 - (rect.top + rect.height / 2)) < 2,
            };
          }),
        );
        assert.ok(
          layout.length === 5 &&
            layout.every((item) => item.direction === 'row' && item.centered && item.fits),
        );
        for (const item of layout)
          assert.deepEqual(item.appearance, layout[0].appearance, '所有操作按钮样式应一致');
        const bounds = await card.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        const expandBounds = await card
          .getByRole('button', { name: '打开完整资料页', exact: true })
          .boundingBox();
        const closeBounds = await card
          .getByRole('button', { name: '关闭', exact: true })
          .boundingBox();
        assert.ok(expandBounds.x + expandBounds.width <= closeBounds.x);
        assert.ok(
          expandBounds.x >= bounds.x &&
            closeBounds.x + closeBounds.width <= bounds.x + bounds.width,
        );
        if (output)
          await page.screenshot({ path: resolve(output, `fixed-card-${theme}-${width}.png`) });
        await card.getByTitle('复制 QQ 号码', { exact: true }).click();
        const feedback = card.locator('.weq-copy-feedback');
        await feedback.waitFor();
        const feedbackBounds = await feedback.boundingBox();
        assert.ok(feedbackBounds.x >= 0 && feedbackBounds.x + feedbackBounds.width <= width);
        assert.equal(await feedback.innerText(), '已复制');
        if (output)
          await page.screenshot({ path: resolve(output, `copy-feedback-${theme}-${width}.png`) });
        await feedback.waitFor({ state: 'detached' });
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await card.getByTitle('复制 QQ 号码', { exact: true }).click();
    await card.locator('.weq-copy-feedback').waitFor();
    assert.equal(
      await card
        .locator('.weq-copy-feedback')
        .evaluate((node) => getComputedStyle(node).animationName),
      'none',
    );
    await card.locator('.weq-copy-feedback').waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1280, height: 900 });
    report.push({ kind: 'card-layout-and-copy', calls: [] });
    await page.evaluate(() => {
      const qa = window.contactCardQa;
      qa.configure({ ...qa.settings, visible: { ...qa.settings.visible, likes: true } });
    });
    await page.getByText('累计获赞', { exact: true }).waitFor();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'dark' ? '#47bc97' : '#c64556',
          );
        }, theme);
        await card.getByRole('button', { name: '查看资料卡点赞', exact: true }).click();
        const dialog = page
          .getByRole('dialog')
          .filter({ has: page.locator('.weq-profile-like-dialog') });
        await dialog.waitFor();
        await dialog.evaluate((node) =>
          Promise.all(node.getAnimations().map((animation) => animation.finished)),
        );
        const presentation = await dialog.evaluate((node) => {
          const layer = node.closest('.weq-dialog-layer');
          const total = node.querySelector('.weq-profile-like-total strong');
          const bounds = node.getBoundingClientRect();
          const number = total.getBoundingClientRect();
          return {
            modal: node.getAttribute('aria-modal'),
            backdrop: getComputedStyle(layer).backgroundColor,
            pointerEvents: getComputedStyle(layer).pointerEvents,
            text: total.textContent,
            fontSize: Number.parseFloat(getComputedStyle(total).fontSize),
            centered:
              Math.abs(number.left + number.width / 2 - (bounds.left + bounds.width / 2)) < 1,
          };
        });
        assert.equal(presentation.modal, null);
        assert.equal(presentation.backdrop, 'rgba(0, 0, 0, 0)');
        assert.equal(presentation.pointerEvents, 'none');
        assert.equal(presentation.text, '128');
        assert.equal(presentation.fontSize, 40);
        assert.ok(presentation.centered);
        const panel = await dialog.boundingBox();
        assert.ok(
          panel.x >= 8 && panel.x + panel.width <= width - 8,
          JSON.stringify({ width, theme, panel }),
        );
        assert.ok(panel.y >= 8 && panel.y + panel.height <= 892);
        if (width === 1280) {
          const source = await card
            .getByRole('button', { name: '查看资料卡点赞', exact: true })
            .boundingBox();
          assert.ok(Math.abs(panel.x - (source.x + source.width + 8)) < 1);
          assert.ok(Math.abs(panel.y - Math.max(8, Math.min(source.y, 892 - panel.height))) < 1);
        }
        if (output)
          await page.screenshot({ path: resolve(output, `profile-like-${theme}-${width}.png`) });
        await dialog.getByRole('button', { name: '自定义点赞次数', exact: true }).click();
        await dialog.getByRole('spinbutton', { name: '资料卡点赞次数', exact: true }).fill('7');
        assert.equal(
          await dialog.getByRole('button', { name: '确认点赞', exact: true }).isEnabled(),
          true,
        );
        await dialog.getByRole('button', { name: '取消自定义点赞', exact: true }).click();
        await dialog.getByRole('button', { name: '关闭资料卡点赞', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await card.count(), 1);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    report.push({ kind: 'profile-like-side-panel', calls: [] });
    // 底部移除点赞入口；累计获赞数值仍沿用上面的面板验证。
    assert.equal(await page.getByRole('button', { name: '赞资料卡', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '预览空间', exact: true }).count(), 0);
    assert.ok(
      !cold.some((call) =>
        /energy|friendClue|friendNotesState|educationHistory|signatureHistory|personalityPhotos|qzone.posts|browseConversation/.test(
          call.path,
        ),
      ),
    );
    assert.ok(
      cold
        .filter((call) => call.path.endsWith('peerStats'))
        .every((call) => JSON.stringify(call.input.fields) === '["level"]'),
    );
    await card.getByRole('button', { name: '没有照片的标签', exact: true }).click();
    await page.getByText('暂无照片', { exact: true }).waitFor();
    assert.equal(await page.locator('.weq-extras-dialog').count(), 0);
    await page.getByRole('button', { name: '关闭标签相册', exact: true }).click();
    await card.getByRole('button', { name: '打开完整资料页', exact: true }).press('Enter');
    await page.locator('.weq-contact-workspace-v2').waitFor();
    const expanded = await page.evaluate(() => window.contactCardQa.calls);
    assert.equal(expanded.filter((call) => call.path === 'account.getProfile').length, 1);
    assert.equal(expanded.filter((call) => call.path === 'account.getCardDisplayNames').length, 1);
    assert.equal(await page.getByRole('button', { name: '标签相册', exact: true }).count(), 0);
    await page.getByRole('button', { name: /没有照片的标签/ }).click();
    await page.getByText('暂无照片', { exact: true }).waitFor();
    assert.equal(await page.locator('.weq-label-album').count(), 1);
    await page.getByRole('button', { name: '关闭标签相册', exact: true }).click();
    assert.equal(
      (await page.evaluate(() => window.contactCardQa.calls)).filter((call) =>
        call.path.endsWith('personalityPhotos'),
      ).length,
      0,
    );
    for (const width of [1280, 390, 320])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'dark' ? '#47bc97' : '#c64556',
          );
        }, theme);
        await page.getByRole('button', { name: '资料页', exact: true }).click();
        if (width > 720) await page.getByRole('button', { name: '概览', exact: true }).click();
        else await page.getByRole('tab', { name: '概览', exact: true }).click();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        );
        assert.equal(overflow, false);
        await checkPrivileges(page.locator('.weq-contact-workspace-v2'));
        if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-page.png`) });
        await page.getByRole('button', { name: '名片设置', exact: true }).click();
        await page.getByRole('switch', { name: 'QQ 能量值', exact: true }).waitFor();
        const settings = page.locator('[data-setting-id="contact-card"]');
        assert.equal(await settings.locator(':scope > .weq-set-card').count(), 7);
        assert.equal(await settings.locator('.weq-set-card .weq-set-card').count(), 0);
        assert.equal(
          await settings.getByText('可点击顶部头像预览效果', { exact: true }).count(),
          1,
        );
        assert.equal(await settings.locator('[data-setting-id="contact-card-preview"]').count(), 0);
        assert.deepEqual(await settings.locator('.weq-set-card-title').allTextContents(), [
          '身份区',
          '群内资料',
          '个人资料',
          '与我的关系',
          '个性展示',
          'QQ 账号',
          '机器人信息',
        ]);
        assert.equal(
          await settings.locator('#contact-card-identity-sort .weq-contact-sort-handle').count(),
          0,
        );
        assert.equal(await settings.getByRole('button', { name: /^(上移|下移)/ }).count(), 0);
        assert.equal(
          await settings.locator('.weq-contact-sort-item').count(),
          await settings.getByRole('switch').count(),
        );
        assert.equal(
          await settings
            .locator('.weq-autosave')
            .evaluate((node) => node.getBoundingClientRect().height),
          0,
        );
        for (const [id, orderKey] of [
          ['contact-card-basic-sort', 'order'],
          ['contact-card-social-sort', 'order'],
          ['contact-card-display-sort', 'order'],
          ['contact-card-account-sort', 'order'],
          ['contact-card-bot-sort', 'order'],
          ['contact-card-group-sort', 'groupOrder'],
        ]) {
          const list = page.locator(`#${id}`);
          await list.evaluate((node) => node.scrollIntoView({ block: 'start' }));
          const before = await list
            .locator('li')
            .evaluateAll((rows) => rows.map((row) => row.dataset.field));
          const savedBefore = await page.evaluate(
            (orderKey) => window.contactCardQa.settings[orderKey],
            orderKey,
          );
          await page.waitForFunction(
            (id) => !document.querySelector(`#${id} .weq-contact-sort-handle`).disabled,
            id,
          );
          await list.locator('.weq-contact-sort-handle').first().dragTo(list.locator('li').nth(1));
          const expected = [before[1], before[0], ...before.slice(2)];
          let index = 0;
          const savedExpected = savedBefore.map((key) =>
            before.includes(key) ? expected[index++] : key,
          );
          await page.waitForFunction(
            ({ id, expected }) =>
              JSON.stringify(
                [...document.querySelectorAll(`#${id} li`)].map((row) => row.dataset.field),
              ) === JSON.stringify(expected),
            { id, expected },
          );
          assert.deepEqual(
            await list.locator('li').evaluateAll((rows) => rows.map((row) => row.dataset.field)),
            expected,
          );
          await page.waitForFunction(
            ({ orderKey, expected }) =>
              JSON.stringify(window.contactCardQa.settings[orderKey]) === JSON.stringify(expected),
            { orderKey, expected: savedExpected },
          );
          // 拖拽不会改变开关；键盘用户仍能在把手上调整顺序。
          const handle = list.locator('.weq-contact-sort-handle').nth(1);
          await handle.focus();
          await handle.press('ArrowUp');
          await page.waitForFunction(
            ({ orderKey, before }) =>
              JSON.stringify(window.contactCardQa.settings[orderKey]) === JSON.stringify(before),
            { orderKey, before: savedBefore },
          );
          await list.locator('.weq-contact-sort-handle').first().press('ArrowUp');
          await list.locator('.weq-contact-sort-handle').last().press('ArrowDown');
          assert.deepEqual(
            await list.locator('li').evaluateAll((rows) => rows.map((row) => row.dataset.field)),
            before,
          );
        }
        const visibilityBefore = await page.evaluate(() => window.contactCardQa.settings.visible);
        const orderBeforeCrossDrop = await page.evaluate(() => window.contactCardQa.settings.order);
        await settings
          .locator('#contact-card-display-sort')
          .evaluate((node) => node.scrollIntoView({ block: 'start' }));
        await settings
          .locator('#contact-card-display-sort .weq-contact-sort-handle')
          .first()
          .dragTo(settings.locator('#contact-card-account-sort li').first());
        assert.deepEqual(
          await page.evaluate(() => window.contactCardQa.settings.order),
          orderBeforeCrossDrop,
        );
        await settings.getByRole('button', { name: '全部隐藏', exact: true }).click();
        await page.waitForFunction(() =>
          Object.values(window.contactCardQa.settings.visible).every((value) => !value),
        );
        assert.equal(await settings.getByRole('switch', { checked: true }).count(), 0);
        await settings.getByRole('button', { name: '全部显示', exact: true }).click();
        await page.waitForFunction(() =>
          Object.values(window.contactCardQa.settings.visible).every(Boolean),
        );
        assert.equal(await settings.getByRole('switch', { checked: false }).count(), 0);
        await page.evaluate(
          (visible) =>
            window.contactCardQa.configure({ ...window.contactCardQa.settings, visible }),
          visibilityBefore,
        );
        const energy = page.getByRole('switch', { name: 'QQ 能量值', exact: true });
        const previousEnergy = (await energy.getAttribute('aria-checked')) === 'true';
        await energy.click();
        await page.waitForFunction(
          (previous) => window.contactCardQa.settings.visible.energy !== previous,
          previousEnergy,
        );
        await energy.click();
        await page.waitForFunction(
          (previous) => window.contactCardQa.settings.visible.energy === previous,
          previousEnergy,
        );
        assert.equal(await page.getByText('能量等级', { exact: false }).count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.evaluate(() => {
          document.scrollingElement.scrollTop = 0;
          document.querySelector('.fixture-body').scrollTop = 0;
        });
        if (output)
          await page.screenshot({ path: resolve(output, `${theme}-${width}-settings.png`) });
        if (output) {
          await settings.locator('#contact-card-bot-sort').scrollIntoViewIfNeeded();
          await page.screenshot({ path: resolve(output, `${theme}-${width}-settings-lower.png`) });
        }
      }
    await page.goto(`${url}?short-signature=1`);
    await page.locator('.weq-contact-signature-text').waitFor();
    assert.equal(
      await page.locator('.weq-contact-signature button:not(.weq-contact-signature-text)').count(),
      0,
    );
    await page.evaluate(() => {
      const qa = window.contactCardQa;
      qa.configure({
        ...qa.settings,
        visible: { ...qa.settings.visible, qid: false, status: false },
      });
    });
    assert.equal(await page.getByTitle('复制 QID', { exact: true }).count(), 0);
    assert.doesNotMatch(await page.locator('.weq-contact-title-line').innerText(), /正在听音乐/);
    report.push({ kind: 'short-signature-and-identity-settings', calls: [] });
    await page.locator('.weq-contact-signature-text').click();
    await page.getByRole('dialog', { name: '历史个性签名', exact: true }).waitFor();
    assert.equal(await page.locator('.weq-member-pop').count(), 1);
    assert.equal(await page.locator('.weq-contact-workspace-v2').count(), 0);
    assert.equal(await page.locator('[aria-modal="true"]').count(), 0);
    report.push({ kind: 'signature-history-popover', calls: [] });
    await page.goto(`${url}?minimal=1&preferences-loading=1`);
    await page.locator('.weq-member-pop').waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const waitingPreferences = await page.evaluate(() => window.contactCardQa.calls);
    assert.ok(
      !waitingPreferences.some((call) =>
        /peerStats|peerHome|peerQqShow|profileExtras|commonRelationships|friendClue|friendNotesState/.test(
          call.path,
        ),
      ),
    );
    report.push({ kind: 'preferences-loading', calls: waitingPreferences });
    await page.evaluate(() => {
      window.contactCardQa.preferencesReady = true;
      window.contactCardQa.notify();
    });
    await page.locator('.weq-member-pop').waitFor();
    await page.waitForTimeout(250);
    const minimal = await page.evaluate(() => window.contactCardQa.calls);
    assert.ok(
      !minimal.some((call) =>
        /peerStats|peerHome|peerQqShow|profileExtras|commonRelationships|friendClue|friendNotesState/.test(
          call.path,
        ),
      ),
    );
    assert.equal(await page.getByRole('button', { name: '预览空间', exact: true }).count(), 0);
    report.push({ kind: 'minimal', calls: minimal });
    await page.evaluate(() => {
      const qa = window.contactCardQa;
      qa.mode = 'nonfriend';
      qa.notify();
    });
    await page.getByText('非好友', { exact: true }).waitFor();
    await page.evaluate(() => {
      const qa = window.contactCardQa;
      qa.mode = 'bot';
      qa.notify();
    });
    await page.getByText('机器人', { exact: true }).waitFor();
    await page.evaluate(() => {
      const qa = window.contactCardQa;
      qa.mode = 'enterprise';
      qa.notify();
    });
    await page.getByText('企业用户', { exact: true }).waitFor();
    await page.evaluate(() => {
      const qa = window.contactCardQa;
      qa.mode = 'friend';
      qa.inGroup = false;
      qa.muted = true;
      qa.notify();
    });
    await page.waitForFunction(() =>
      document.querySelector('.weq-member-pop')?.textContent?.includes('禁言截止'),
    );
    assert.ok(!(await page.locator('.weq-member-pop').textContent()).includes('已退群'));
    const beforeClone = await page.evaluate(
      () =>
        window.contactCardQa.calls.filter((call) =>
          /getProfile|getBotProfile|getCardDisplayNames/.test(call.path),
        ).length,
    );
    await page.evaluate(() => {
      const qa = window.contactCardQa;
      qa.mode = 'clone';
      qa.notify();
    });
    await page.waitForFunction(() =>
      document.querySelector('.weq-member-pop')?.textContent?.includes('合成本地好友'),
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.contactCardQa.calls.filter((call) =>
            /getProfile|getBotProfile|getCardDisplayNames/.test(call.path),
          ).length,
      ),
      beforeClone,
    );
    assert.ok(!(await page.locator('.weq-member-pop').textContent()).includes('QQ'));
    await page.evaluate(() => {
      const qa = window.contactCardQa;
      qa.mode = 'self';
      qa.notify();
    });
    await page.locator('.weq-profile-name').click();
    await page.locator('.weq-contact-workspace-v2').waitFor();
    assert.ok(
      await page.evaluate(() =>
        Boolean(
          document.querySelector('option[value="edit"]') ||
            [...document.querySelectorAll('.weq-profile-directory button')].find(
              (button) => button.textContent === '编辑资料',
            ),
        ),
      ),
    );
    report.push({ kind: 'identity-matrix', calls: [] });
    await page.evaluate(() => {
      window.contactCardQa.account = '10004';
      window.contactCardQa.config = 'other';
      window.contactCardQa.notify();
    });
    await page.waitForTimeout(150);
    report.push({
      kind: 'account-switch',
      calls: await page.evaluate(() => window.contactCardQa.calls),
    });
  }
  assert.deepEqual(errors, []);
  if (output)
    await writeFile(
      resolve(output, baseline ? 'baseline.json' : 'report.json'),
      JSON.stringify(report, null, 2),
    );
  console.log(
    JSON.stringify({
      passed: true,
      baseline,
      checks: report.map((row) => ({ kind: row.kind, calls: row.calls.length })),
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
