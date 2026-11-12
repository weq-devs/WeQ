import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const stub = resolve(root, 'test/browser/contact-card.stub.ts');
const output = process.env.WEQ_PROFILE_AUDIT_ARTIFACTS ?? '/tmp/weq-qa/shots/card';
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-profile-audit'),
  plugins: [react(), tailwind()],
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
const report = {};
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  await mkdir(output, { recursive: true });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-audit.html`;

  async function open(query, { width = 1280, height = 900, theme = 'light' } = {}) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ||
      route.request().url().startsWith('data:')
        ? route.continue()
        : route.abort(),
    );
    await page.addInitScript(
      ({ theme }) => {
        const apply = () => {
          if (!document.documentElement) return;
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'dark' ? '#47bc97' : '#c64556',
          );
        };
        apply();
        document.addEventListener('DOMContentLoaded', apply);
      },
      { theme },
    );
    await page.goto(`${base}?${query}`);
    await page.waitForTimeout(450);
    return { page, errors };
  }

  // ---------- 静态矩阵 ----------
  const cells = [];
  for (const view of ['card', 'page', 'settings', 'settings-loading']) {
    for (const width of [1280, 390, 320]) {
      for (const theme of ['light', 'dark']) cells.push({ view, width, theme, state: 'default' });
    }
  }
  for (const view of ['card', 'page'])
    for (const state of ['long', 'empty'])
      for (const width of [1280, 390, 320])
        for (const theme of ['light', 'dark']) cells.push({ view, width, theme, state });

  for (const cell of cells) {
    const query = [
      `view=${cell.view === 'settings-loading' ? 'settings' : cell.view}`,
      `state=${cell.state}`,
      cell.view === 'settings-loading' ? 'preferences-loading=1' : '',
    ]
      .filter(Boolean)
      .join('&');
    const { page, errors } = await open(query, {
      width: cell.width,
      // 设置页整页很长：给足视口高度，避免内层滚动导致整页截图被裁。
      height: cell.view.startsWith('settings') ? 4200 : cell.width <= 390 ? 780 : 900,
      theme: cell.theme,
    });
    await page.evaluate(() => {
      document.scrollingElement.scrollTop = 0;
      const body = document.querySelector('.audit-body');
      if (body) body.scrollTop = 0;
    });
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth > innerWidth,
      cardWidth: document.querySelector('.weq-member-pop')?.getBoundingClientRect().width ?? null,
    }));
    if (overflow.doc)
      report[`overflow:${cell.view}-${cell.width}-${cell.theme}-${cell.state}`] = true;
    if (cell.view === 'card') {
      if (await page.locator('.weq-contact-remarks').count())
        assert.equal(
          await page
            .locator('.weq-contact-sections')
            .evaluate((node) => getComputedStyle(node).borderTopWidth),
          '1px',
          '备注与基本信息之间保留分割线',
        );
      const sections = await page.locator('.weq-contact-sections').evaluate((container) =>
        [...container.children]
          .filter(
            (node) => node.matches('.weq-profile-section-block') && node.getClientRects().length,
          )
          .map((node) => ({
            title: node.querySelector('h3')?.textContent ?? '',
            border: getComputedStyle(node).borderTopWidth,
          })),
      );
      sections.forEach((section, index) => {
        assert.equal(section.border, index ? '1px' : '0px', `分区分割线：${section.title}`);
      });
      if (cell.state !== 'empty') {
        assert.equal(
          await page.locator('.weq-profile-subtitle').filter({ hasText: '群内资料' }).textContent(),
          `群内资料（${cell.state === 'long' ? '一个名字特别长的群聊用来测试群上下文标题换行' : '合成群'}）`,
        );
        for (const field of ['company', 'description', 'email'])
          assert.ok(
            await page.locator(`[data-profile-field="${field}"]`).isVisible(),
            `${field} 直接可见`,
          );
        assert.equal(await page.getByRole('button', { name: '详细资料', exact: true }).count(), 0);
      }
    }
    await page.screenshot({
      path: resolve(output, `${cell.view}-${cell.state}-${cell.width}-${cell.theme}.png`),
      fullPage: false,
    });
    if (cell.view === 'card' && cell.state !== 'empty') {
      await page
        .locator('.weq-profile-subtitle')
        .filter({ hasText: '群内资料' })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(output, `card-group-${cell.state}-${cell.width}-${cell.theme}.png`),
      });
    }
    if (cell.view.startsWith('settings'))
      await page.screenshot({
        path: resolve(
          output,
          `settings-page-${cell.width}-${cell.theme}${cell.view === 'settings-loading' ? '-loading' : ''}.png`,
        ),
      });
    assert.deepEqual(errors, [], `${cell.view}/${cell.state}/${cell.width}/${cell.theme}`);
    await page.close();
  }

  // ---------- 隐藏与空字段不在首个可见分区前留下分割线 ----------
  for (const theme of ['light', 'dark']) {
    const { page } = await open('view=card&minimal=1', { width: 320, theme });
    const group = page.locator('.weq-profile-section-block').filter({ hasText: '群内资料' });
    assert.equal(await group.evaluate((node) => getComputedStyle(node).borderTopWidth), '0px');
    await page.evaluate(() => {
      const qa = window.profileAuditQa;
      qa.configure({ ...qa.settings, visible: { ...qa.settings.visible, company: true } });
    });
    await page.locator('[data-profile-field="company"]').waitFor();
    assert.equal(await group.evaluate((node) => getComputedStyle(node).borderTopWidth), '1px');
    await page.screenshot({ path: resolve(output, `card-minimal-320-${theme}.png`) });
    await page.close();
  }

  for (const theme of ['light', 'dark']) {
    const { page } = await open('view=card&no-remark=1', { width: 320, theme });
    const remarks = page.locator('.weq-contact-remarks');
    assert.equal(
      await remarks.locator('.weq-profile-identity-remark').innerText(),
      '备注\n添加备注',
    );
    assert.equal(await remarks.locator('.weq-profile-data-row').count(), 1);
    assert.equal(
      await page.locator('.weq-contact-meta').filter({ hasText: '添加备注' }).count(),
      0,
    );
    assert.equal(await page.getByRole('button', { name: '我的备注资料', exact: true }).count(), 0);
    await page.screenshot({ path: resolve(output, `card-add-remark-320-${theme}.png`) });
    await page.close();
  }

  // ---------- QID、UID 身份区可选项与资料页技术详情 ----------
  for (const theme of ['light', 'dark']) {
    const { page } = await open('view=card&state=default', { theme });
    await page.locator('.weq-member-pop').waitFor();
    const read = () =>
      page.evaluate(() => document.querySelector('.weq-member-pop')?.innerText ?? '');
    const initial = await read();
    assert.ok(initial.includes('QID'), 'QID 默认开，应在名片身份区');
    assert.match(await page.locator('.weq-contact-meta').last().innerText(), /QID/);
    assert.ok(!initial.includes('UID'), 'UID 默认关，不应在名片正文');
    await page.screenshot({
      path: resolve(output, `card-qid-on-1280-${theme}.png`),
    });
    // 关 QID、开 UID
    await page.evaluate(() => {
      const qa = window.profileAuditQa;
      qa.configure({ ...qa.settings, visible: { ...qa.settings.visible, qid: false, uid: true } });
    });
    await page.waitForTimeout(300);
    const toggled = await read();
    assert.ok(!toggled.includes('QID'), '关闭 QID 后名片不应出现');
    assert.ok(toggled.includes('UID'), '开启 UID 后身份区应出现');
    assert.match(await page.locator('.weq-contact-meta').last().innerText(), /UID/);
    assert.equal(await page.locator('[data-profile-field="uid"]').count(), 0);
    await page.screenshot({
      path: resolve(output, `card-qid-off-1280-${theme}.png`),
    });
    report[`qidToggle:${theme}`] = {
      initial: { qid: initial.includes('QID'), uid: initial.includes('UID') },
      toggled: { qid: toggled.includes('QID'), uid: toggled.includes('UID') },
    };
    await page.evaluate(() => {
      const qa = window.profileAuditQa;
      qa.configure({ ...qa.settings, visible: { ...qa.settings.visible, qid: true, uid: true } });
    });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const numbers = page.locator('.weq-contact-meta').last();
      await numbers.getByRole('button', { name: '复制 UID', exact: true }).waitFor();
      assert.match(await numbers.innerText(), /QQ.*QID.*UID/s);
      assert.ok(
        await numbers.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        '编号区窄屏不溢出',
      );
      await page.screenshot({ path: resolve(output, `card-all-ids-${width}-${theme}.png`) });
    }
    // 资料页技术详情不随开关变化
    await page.evaluate(() => {
      const qa = window.profileAuditQa;
      qa.configure({ ...qa.settings, visible: { ...qa.settings.visible, qid: false, uid: false } });
    });
    await page.evaluate(() => {
      document.querySelector('.audit-tools button:nth-child(2)')?.click();
    });
    await page.waitForTimeout(400);
    await page.locator('.weq-profile-tech > summary').click();
    const tech = await page.evaluate(
      () => document.querySelector('.weq-profile-tech')?.innerText ?? '',
    );
    assert.ok(!tech.includes('QID') && tech.includes('UID'), '技术详情只保留 UID');
    assert.match(await page.locator('.weq-contact-meta').last().innerText(), /QID/);
    report[`qidTechnical:${theme}`] = tech.replace(/\s+/g, ' ').slice(0, 80);
    await page.close();
  }

  // ---------- 交互验证 ----------
  {
    const { page } = await open('view=card&state=default');
    // 1. ESC 关闭
    await page.locator('.weq-member-pop').waitFor();
    await page.keyboard.press('Escape');
    const escClosed = await page
      .locator('.weq-member-pop')
      .waitFor({ state: 'detached', timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    report.escClosesCard = escClosed;
    await page.close();
  }
  {
    const { page } = await open('view=card&state=default');
    await page.locator('.weq-member-pop').waitFor();
    const signature = page.locator('.weq-contact-signature p');
    const box = await signature.boundingBox();
    await page.mouse.move(box.x + 4, box.y + 6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 6, box.y + 6, { steps: 10 });
    await page.mouse.up();
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    await page.waitForTimeout(200);
    const navigated = await page.locator('.weq-contact-workspace-v2').count();
    report.dragSelectSignature = { selected: selected.slice(0, 12), navigated: navigated > 0 };
    // 点击昵称是「查看完整资料」，应当进入资料页
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.locator('.weq-contact-name').click();
    const opened = await page
      .locator('.weq-profile-workspace')
      .waitFor({ timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    report.nameOpensPage = opened;
    await page.close();
  }
  {
    const { page } = await open('view=card&state=default');
    await page.locator('.weq-member-pop').waitFor();
    // 触控热区
    report.tapTargets = await page.evaluate(() =>
      [...document.querySelectorAll('.weq-member-pop button, .weq-member-pop [role="button"]')]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            text: (node.textContent ?? '').trim().slice(0, 14),
            cls: node.className.toString().split(' ')[0],
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          };
        })
        .filter((row) => row.h < 44 || row.w < 24),
    );
    // 信息层级
    report.cardText = await page.evaluate(() => {
      const card = document.querySelector('.weq-member-pop');
      return {
        hasQid: card.textContent.includes('QID'),
        hasUid: card.textContent.includes('UID'),
        groupHeadingLevels: [...card.querySelectorAll('h1,h2,h3,h4')].map(
          (node) => node.tagName + ':' + node.textContent.trim().slice(0, 20),
        ),
        headings: [...card.querySelectorAll('.weq-profile-name, .weq-profile-id')].map((n) =>
          n.textContent.trim().slice(0, 24),
        ),
        labelledRows: [...card.querySelectorAll('.weq-profile-row')].map((row) => ({
          label: row.querySelector('.weq-profile-row-label')?.textContent?.trim() ?? null,
          value: (
            row.querySelector('.weq-profile-row-value, .weq-contact-value')?.textContent ?? ''
          )
            .trim()
            .slice(0, 22),
        })),
        gridTemplate: (() => {
          const row = card.querySelector('.weq-contact-content .weq-profile-row');
          return row ? getComputedStyle(row).gridTemplateColumns : null;
        })(),
        avatar: (() => {
          const node = card.querySelector('.weq-profile-avatar');
          return node ? Math.round(node.getBoundingClientRect().width) : null;
        })(),
        siblingBlocks: [...card.children].map(
          (node) => node.className.toString().split(' ').slice(0, 2).join('.') || node.tagName,
        ),
      };
    });
    // 关闭按钮位置与焦点恢复
    const closeButton = page.locator('.weq-profile-close');
    report.closeButton = await closeButton.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const card = node.closest('.weq-member-pop').getBoundingClientRect();
      return {
        rightGap: Math.round(card.right - rect.right),
        topGap: Math.round(rect.top - card.top),
        size: [Math.round(rect.width), Math.round(rect.height)],
      };
    });
    await closeButton.click();
    await page.waitForTimeout(200);
    report.afterClose = await page.evaluate(() => ({
      view: document.getElementById('audit-view')?.textContent,
      active: document.activeElement?.tagName + '.' + (document.activeElement?.className ?? ''),
    }));
    await page.close();
  }
  {
    // 设置：结构一致性 + 键盘排序 + 预览=本人真实数据
    const { page } = await open('view=settings&state=default');
    await page.locator('.weq-contact-sort-item').first().waitFor();
    const sortIds = () =>
      page
        .locator('.weq-contact-sort')
        .first()
        .locator('.weq-contact-sort-item .weq-contact-sort-label')
        .allTextContents();
    const before = await sortIds();
    const up = page.getByRole('button', { name: /^上移/ }).nth(2);
    await up.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    const after = await sortIds();
    report.keyboardSort = {
      before: before.slice(0, 4),
      after: after.slice(0, 4),
      changed: JSON.stringify(before) !== JSON.stringify(after),
      focusKept: await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    };
    // 把手方向键排序
    const handle = page.locator('.weq-contact-sort-handle').nth(3);
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    report.handleArrowSort = { changed: JSON.stringify(await sortIds()) !== JSON.stringify(after) };
    // 与其它设置对比：SectionHeader / Card / Row / Toggle
    report.settingsStructure = await page.evaluate(() => {
      const root = document.querySelector('[data-setting-id="contact-card"]');
      return {
        hasSetHead: Boolean(root.querySelector('.weq-set-head')),
        setHeadResetText:
          root.querySelector('.weq-settings-page-reset button')?.textContent?.trim() ?? null,
        cards: root.querySelectorAll('.weq-set-card').length,
        rows: root.querySelectorAll('.weq-set-row').length,
        switches: root.querySelectorAll('[role="switch"]').length,
        nativeCheckboxes: root.querySelectorAll('input[type="checkbox"]').length,
        titleSize: getComputedStyle(root.querySelector('.weq-set-title')).fontSize,
        cardRadius: getComputedStyle(root.querySelector('.weq-set-card')).borderRadius,
        fieldCardOrder: [...root.querySelectorAll('.weq-set-card .weq-set-card-title')].map((n) =>
          n.textContent.trim(),
        ),
        rowHeight: Math.round(
          root.querySelector('.weq-set-card > .weq-set-row')?.getBoundingClientRect().height ?? 0,
        ),
        rowGap: (() => {
          const rows = [...root.querySelectorAll('.weq-set-card > .weq-set-row')].slice(0, 3);
          if (rows.length < 2) return null;
          return Math.round(
            rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom,
          );
        })(),
      };
    });
    // 设置页不再重复渲染名片，预览由顶部头像进入。
    report.preview = await page.evaluate(() => {
      const preview = document.querySelector('.weq-contact-card-preview');
      const text = preview?.textContent ?? '';
      return {
        exists: Boolean(preview),
        uid: preview?.getAttribute('data-preview-uid') ?? null,
        fictional: /示例联系人|示例大学|示例公司|sample-person|sample@example|u_sample/.test(text),
        skeleton: /读取本人资料后/.test(text),
        sample: text.replace(/\s+/g, ' ').slice(0, 120),
      };
    });
    // 开关与排序共用同一行。
    const toggle = page.getByRole('switch', { name: 'QQ 等级' }).first();
    const checkedBefore = await toggle.getAttribute('aria-checked');
    await toggle.click();
    await page.waitForTimeout(300);
    report.fieldToggle = {
      before: checkedBefore,
      after: await toggle.getAttribute('aria-checked'),
      inSortRow: await toggle.evaluate((node) => Boolean(node.closest('.weq-contact-sort-item'))),
    };
    // 自动保存态
    report.autoSave = await page.evaluate(() => {
      const node = document.querySelector(
        '[data-setting-id="contact-card"] .weq-set-autosave, [data-setting-id="contact-card"] [class*="autosave"]',
      );
      return node ? { cls: node.className.toString(), text: node.textContent.trim() } : null;
    });
    await page.screenshot({ path: resolve(output, 'settings-interacted-1280.png') });
    await page.close();
  }
  {
    // 320 窄屏：设置与资料页溢出、目录控件
    for (const width of [390, 320]) {
      const { page } = await open('view=page&state=default', { width, height: 780 });
      await page.locator('.weq-profile-directory-tabs').waitFor();
      const tabsVisible = await page.locator('.weq-profile-directory-tabs').isVisible();
      const options = await page.locator('.weq-profile-directory-tab').allTextContents();
      await page.getByRole('tab', { name: '详细资料', exact: true }).click();
      await page.waitForTimeout(200);
      report[`narrowPage:${width}`] = {
        selectVisible: tabsVisible,
        options,
        title: await page.locator('.weq-contact-section-title').first().textContent(),
        overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        toolbarFocusable: await page.locator('.weq-profile-page-toolbar button').count(),
      };
      await page.close();
    }
    const { page } = await open('view=settings&state=default', { width: 320, height: 780 });
    await page.locator('.weq-contact-sort-item').first().waitFor();
    report.narrowSettings = await page.evaluate(() => {
      const previewCard = document.querySelector('[data-setting-id="contact-card-preview"]');
      const item = document.querySelector('.weq-contact-sort-item');
      return {
        previewRemoved: !previewCard,
        cards: document.querySelectorAll('[data-setting-id="contact-card"] .weq-set-card').length,
        sortRowOverflow: item ? item.scrollWidth > item.clientWidth : null,
        docOverflow: document.documentElement.scrollWidth > innerWidth,
        toggleCount: document.querySelectorAll('[data-setting-id="contact-card"] [role="switch"]')
          .length,
      };
    });
    await page.close();
  }
  // 资料页：目录、标题层级、加载/空态
  for (const width of [1280, 390]) {
    const { page } = await open('view=page&state=long', { width, height: 900 });
    await page.locator('.weq-contact-workspace-v2').waitFor();
    report[`pageLong:${width}`] = await page.evaluate(() => {
      const body = document.querySelector('.weq-contact-workspace-body');
      const title = document.querySelector('.weq-contact-section-title');
      const row = document.querySelector('.weq-contact-content .weq-profile-row');
      return {
        bodyWidth: body ? Math.round(body.getBoundingClientRect().width) : null,
        titleFont: title ? getComputedStyle(title).fontSize : null,
        grid: row ? getComputedStyle(row).gridTemplateColumns : null,
        toolbarText: document.querySelector('.weq-contact-page-toolbar')?.textContent?.trim(),
        headings: [
          ...document.querySelectorAll(
            '.weq-contact-profile-v2 h1,.weq-contact-profile-v2 h2,.weq-contact-profile-v2 h3',
          ),
        ].map((n) => `${n.tagName}:${n.textContent.trim().slice(0, 16)}`),
        lineLength: (() => {
          const node = document.querySelector('.weq-contact-content');
          if (!node) return null;
          const style = getComputedStyle(node);
          return {
            width: Math.round(node.getBoundingClientRect().width),
            fontSize: style.fontSize,
          };
        })(),
      };
    });
    await page.close();
  }
  await writeFile(resolve(output, 'audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
