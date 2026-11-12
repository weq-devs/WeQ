import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
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
      await card.locator('.weq-contact-meta').last().innerText(),
      /QQ\s+10002.*QID\s+sample-person/s,
    );
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
    assert.equal(await levelSection.locator('h3').innerText(), '基本信息');
    await page.context().grantPermissions(['clipboard-write', 'clipboard-read']);
    await card.getByRole('button', { name: '复制 QQ 号码', exact: true }).click();
    await card.locator('.weq-contact-copy-feedback').waitFor();
    assert.equal(
      await card
        .locator('.weq-contact-copy-feedback')
        .evaluate((node) => getComputedStyle(node).animationName),
      'weq-contact-copy-fade',
    );
    assert.ok(
      await card.locator('.weq-contact-copy-feedback').evaluate((node) => {
        const animation = node.getAnimations()[0];
        animation.pause();
        animation.currentTime = 1650;
        const opacity = Number.parseFloat(getComputedStyle(node).opacity);
        animation.play();
        return opacity > 0 && opacity < 0.5;
      }),
    );
    await card.locator('.weq-contact-copy-feedback').waitFor({ state: 'detached' });
    const signature = card.locator('.weq-contact-signature');
    await signature.getByRole('button', { name: '展开' }).click();
    assert.equal(
      await signature.locator('p').evaluate((node) => node.scrollHeight > node.clientHeight + 1),
      false,
    );
    await signature.getByRole('button', { name: '收起' }).click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const layout = await card.locator('.weq-contact-actions > button').evaluateAll((buttons) =>
          buttons.map((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            const icon = node.querySelector('svg').getBoundingClientRect();
            return {
              direction: style.flexDirection,
              height: rect.height,
              centered: Math.abs(icon.top + icon.height / 2 - (rect.top + rect.height / 2)) < 2,
            };
          }),
        );
        assert.ok(
          layout.length >= 2 && layout.every((item) => item.direction === 'row' && item.centered),
        );
        assert.equal(layout[0].height, layout[1].height);
        const bounds = await card.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        if (output)
          await page.screenshot({ path: resolve(output, `fixed-card-${theme}-${width}.png`) });
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await card.getByRole('button', { name: '复制 QQ 号码', exact: true }).click();
    await card.locator('.weq-contact-copy-feedback').waitFor();
    assert.equal(
      await card
        .locator('.weq-contact-copy-feedback')
        .evaluate((node) => getComputedStyle(node).animationName),
      'none',
    );
    await card.locator('.weq-contact-copy-feedback').waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1280, height: 900 });
    report.push({ kind: 'card-layout-and-copy', calls: [] });
    await page.evaluate(() => {
      const qa = window.contactCardQa;
      qa.configure({ ...qa.settings, visible: { ...qa.settings.visible, likes: true } });
    });
    await page.getByText('累计获赞', { exact: true }).waitFor();
    // 点赞与空间预览收进操作行的「更多操作」，展开后仍然只有一个入口。
    await page.locator('.weq-contact-overflow > summary').click();
    await page.getByRole('button', { name: '赞资料卡', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '赞资料卡', exact: true }).count(), 1);
    await page.locator('.weq-contact-overflow > summary').click();
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
    await page.locator('.weq-profile-name').click();
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
    for (const width of [1280, 390])
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
        if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-page.png`) });
        await page.getByRole('button', { name: '名片设置', exact: true }).click();
        await page.getByRole('switch', { name: 'QQ 能量值', exact: true }).waitFor();
        // 预览必须用本人资料，不能出现任何虚构联系人
        const previewText = await page.locator('.weq-contact-card-preview').innerText();
        assert.equal(
          /示例联系人|示例大学|示例公司|sample-person|sample@example/.test(previewText),
          false,
        );
        // 预览内容来自本人（self）资料，不是任何合成好友
        assert.match(previewText, /自己的公司/);
        await page.getByRole('switch', { name: 'QQ 能量值', exact: true }).click();
        await page.getByRole('switch', { name: 'QQ 能量值', exact: true }).click();
        assert.equal(await page.getByText('能量等级', { exact: false }).count(), 0);
        await page.evaluate(() => {
          document.scrollingElement.scrollTop = 0;
          document.querySelector('.fixture-body').scrollTop = 0;
        });
        if (output)
          await page.screenshot({ path: resolve(output, `${theme}-${width}-settings.png`) });
      }
    await page.goto(`${url}?short-signature=1`);
    await page.locator('.weq-contact-signature p').waitFor();
    assert.equal(await page.locator('.weq-contact-signature button').count(), 0);
    await page.evaluate(() => {
      const qa = window.contactCardQa;
      qa.configure({
        ...qa.settings,
        visible: { ...qa.settings.visible, qid: false, status: false },
      });
    });
    assert.equal(await page.getByRole('button', { name: '复制 QID', exact: true }).count(), 0);
    assert.doesNotMatch(await page.locator('.weq-contact-title-line').innerText(), /正在听音乐/);
    report.push({ kind: 'short-signature-and-identity-settings', calls: [] });
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
    // 空间预览在「更多操作」菜单里
    await page.locator('.weq-contact-overflow > summary').click();
    await page.getByRole('button', { name: '预览空间', exact: true }).click();
    await page.getByText('合成空间预览', { exact: true }).waitFor();
    await page.locator('.weq-contact-overflow > summary').click();
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
