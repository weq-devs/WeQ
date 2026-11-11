import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_GROUP_AUDIT_ARTIFACTS ?? '/tmp/weq-qa/shots/group-audit';
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-group-audit'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-audit.stub.ts'),
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
const report = { shots: [], metrics: {}, issues: [], errors: [] };
let browser;
const shot = async (page, name) => {
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path });
  report.shots.push(path);
};
const setTheme = async (page, theme) => {
  await page.evaluate((value) => {
    window.groupAuditQa.theme.getState().setPreference(value);
    window.groupAuditQa.theme.getState().setAccent(value === 'light' ? '#075c30' : '#fff3a1');
  }, theme);
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
};
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.route('**/*', (route) =>
    ['127.0.0.1'].includes(new URL(route.request().url()).hostname) ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const base = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-audit.html`;
  const open = async (state, view) => {
    await page.goto(`${base}?state=${state}&view=${view}`);
    await page.locator('.weq-profile-hero').first().waitFor();
    await page.waitForTimeout(900);
  };

  // ---- 快速名片（真实浮层）----
  await page.setViewportSize({ width: 390, height: 780 });
  await open('ok', 'card');
  await page.locator('.weq-group-preview-avatars button').first().waitFor();
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await page.setViewportSize({ width: 390, height: 780 });
    await shot(page, `card-390-${theme}`);
    await page.setViewportSize({ width: 320, height: 780 });
    await shot(page, `card-320-${theme}`);
  }
  await setTheme(page, 'light');
  await page.setViewportSize({ width: 390, height: 780 });
  report.metrics.card = await page.evaluate(() => {
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const card = document.querySelector('.weq-group-card');
    const style = card && getComputedStyle(card);
    const name = document.querySelector('.weq-profile-name');
    return {
      cardClass: card?.className,
      cardWidth: box(card),
      radius: style?.borderRadius,
      padding: style?.padding,
      backgroundImage: style?.backgroundImage?.slice(0, 80),
      nameSize: name ? getComputedStyle(name).fontSize : null,
      nameBox: box(name),
      avatarBox: box(document.querySelector('.weq-profile-avatar')),
      closeBox: box(document.querySelector('.weq-profile-close')),
      actionsBox: box(document.querySelector('.weq-group-card-actions')),
      rowCount: document.querySelectorAll('.weq-profile-data-row').length,
      dlCount: document.querySelectorAll('.weq-group-card dl').length,
      tagCount: document.querySelectorAll('.weq-group-tags .weq-profile-tag').length,
      hasTechnical: Boolean(document.querySelector('.weq-group-card details')),
      text: document.querySelector('.weq-group-card')?.innerText,
    };
  });
  await page.getByRole('button', { name: '展开', exact: true }).click();
  await shot(page, 'card-390-light-expanded');
  report.metrics.expandedClamp = await page.locator('.weq-group-description .is-clamped').count();
  await page.getByRole('button', { name: '收起', exact: true }).click();
  report.metrics.collapsedClamp = await page.locator('.weq-group-description .is-clamped').count();
  // 拖选简介不应折叠
  await page.evaluate(() => {
    const node = document.querySelector('.weq-group-description p');
    const range = document.createRange();
    range.selectNodeContents(node);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.waitForTimeout(200);
  report.metrics.afterSelectionTextLength = await page.evaluate(
    () => document.querySelector('.weq-group-description p')?.textContent.length,
  );
  await page.evaluate(() => getSelection().removeAllRanges());
  // 成员预览 → 名片 → ESC
  await page.locator('.weq-group-preview-avatars button').first().click();
  await page.getByRole('dialog', { name: '用户资料', exact: true }).waitFor();
  await shot(page, 'card-390-light-member');
  report.metrics.memberCardScroll = await page.evaluate(() => {
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const member = document.querySelector('.weq-member-pop');
    return {
      memberBox: box(member),
      groupCardVisible: Boolean(document.querySelector('.weq-group-card')),
    };
  });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '用户资料', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('dialog', { name: '群资料', exact: true }).waitFor();
  report.metrics.escReturnsToGroupCard = true;

  // ---- 完整资料页十章 ----
  await page.setViewportSize({ width: 1180, height: 900 });
  await open('ok', 'page');
  const nav = page.getByRole('navigation', { name: '群详情分区' });
  await nav.waitFor();
  const tabs = [
    '概览',
    '详细资料',
    '成员',
    '公告',
    '相册',
    '文件',
    '精华',
    '打卡',
    '群管理',
    '资料历史',
  ];
  await setTheme(page, 'light');
  for (const tab of tabs) {
    await nav.getByRole('button', { name: tab, exact: true }).click({ timeout: 8000 });
    await page.waitForTimeout(600);
    await shot(page, `page-1180-light-${tab}`);
    report.metrics[`page-${tab}`] = await page.evaluate(() => {
      const body = document.querySelector('.weq-profile-workspace-body');
      const region = body
        ? [...body.querySelectorAll('[role="region"]')].find((node) => !node.hasAttribute('hidden'))
        : null;
      const title = region?.querySelector('.weq-contact-section-title');
      return {
        visibleTitle: title?.textContent ?? null,
        titleFontSize: title ? getComputedStyle(title).fontSize : null,
        regionText: (region?.innerText ?? '').slice(0, 240),
        dataRows: region ? region.querySelectorAll('.weq-profile-data-row').length : 0,
        dlRows: region ? region.querySelectorAll('dl > div').length : 0,
        bodyScrollHeight: body?.scrollHeight,
        innerHeight,
      };
    });
  }
  await nav.getByRole('button', { name: '详细资料', exact: true }).click();
  await page.waitForTimeout(500);
  report.metrics.detailsRows = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.weq-group-details-rows .weq-profile-data-row')];
    return rows.slice(0, 4).map((row) => {
      const label = row.querySelector('.weq-profile-data-label');
      const value = row.querySelector('.weq-profile-data-value');
      const rect = row.getBoundingClientRect();
      return {
        label: label?.textContent,
        value: value?.textContent,
        rowHeight: Math.round(rect.height),
        labelWidth: label ? Math.round(label.getBoundingClientRect().width) : null,
        valueX: value ? Math.round(value.getBoundingClientRect().x) : null,
        labelFont: label ? getComputedStyle(label).fontSize : null,
        valueFont: value ? getComputedStyle(value).fontSize : null,
        labelColor: label ? getComputedStyle(label).color : null,
      };
    });
  });
  report.metrics.technical = await page.evaluate(() => {
    const node = document.querySelector('.weq-profile-tech');
    return node
      ? {
          summary: node.querySelector('summary')?.textContent,
          open: node.hasAttribute('open'),
          parentClass: node.parentElement?.className,
          rows: [...node.querySelectorAll('dt')].map((dt) => dt.textContent),
        }
      : null;
  });
  report.metrics.extrasRows = await page.evaluate(() =>
    [...document.querySelectorAll('.weq-group-extras-rows .weq-profile-data-label')].map(
      (dt) => dt.textContent,
    ),
  );
  report.metrics.detailsText = await page.evaluate(
    () => document.querySelector('.weq-group-details')?.innerText ?? '',
  );
  await setTheme(page, 'dark');
  for (const tab of tabs) {
    await nav.getByRole('button', { name: tab, exact: true }).click();
    await page.waitForTimeout(400);
    await shot(page, `page-1180-dark-${tab}`);
  }
  await setTheme(page, 'light');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 860 });
    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      const strip = page.getByRole('tablist', { name: '群详情分区' });
      for (const tab of ['概览', '详细资料', '成员', '相册', '文件', '群管理']) {
        await strip.getByRole('tab', { name: tab, exact: true }).click();
        await page.waitForTimeout(400);
        await shot(page, `page-${width}-${theme}-${tab}`);
      }
    }
    await setTheme(page, 'light');
  }

  // ---- 长名称 ----
  await page.setViewportSize({ width: 320, height: 860 });
  await open('long', 'page');
  await page.waitForTimeout(500);
  report.metrics.longName320 = await page.evaluate(() => {
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const close = box(document.querySelector('.weq-profile-page-close'));
    const name = box(document.querySelector('.weq-profile-name'));
    const overlap = Boolean(
      close &&
        name &&
        close.x < name.x + name.width &&
        close.x + close.width > name.x &&
        close.y < name.y + name.height &&
        close.y + close.height > name.y,
    );
    const element = document.elementFromPoint(
      close.x + close.width / 2,
      close.y + close.height / 2,
    );
    return {
      close,
      name,
      overlap,
      topElementAtClose: element ? `${element.tagName}.${element.className}`.slice(0, 80) : null,
      toolbar: box(document.querySelector('.weq-profile-page-toolbar')),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
    };
  });
  await shot(page, 'page-320-light-long');
  await open('long', 'card');
  await page.setViewportSize({ width: 320, height: 780 });
  await shot(page, 'card-320-light-long');
  // 吸底操作行：长简介 + 多数据行的名片在 1180/390 × 浅深下的表现
  for (const width of [1180, 390]) {
    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      await page.setViewportSize({ width, height: 860 });
      await shot(page, `card-${width}-${theme}-long`);
    }
  }
  // 吸底操作行：滚到底部后最后一行内容是否被遮挡
  await page.setViewportSize({ width: 390, height: 860 });
  await setTheme(page, 'dark');
  report.metrics.stickyActions = await page.evaluate(() => {
    const card = document.querySelector('.weq-group-card');
    if (!card) return null;
    card.scrollTop = card.scrollHeight;
    const actions = card.querySelector('.weq-profile-card-actions');
    const lastChild =
      card.lastElementChild === actions ? actions.previousElementSibling : card.lastElementChild;
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
      };
    };
    const lastInside = lastChild?.lastElementChild ?? lastChild;
    return {
      actionsIsLast: card.lastElementChild === actions,
      actionsBox: box(actions),
      lastContentBox: box(lastInside),
      cardScrollable: card.scrollHeight > card.clientHeight,
      scrollTop: card.scrollTop,
      paddingBottom: getComputedStyle(card).paddingBottom,
      cardBox: box(card),
      actionsStyle: actions
        ? {
            position: getComputedStyle(actions).position,
            top: getComputedStyle(actions).top,
            bottom: getComputedStyle(actions).bottom,
            background: getComputedStyle(actions).backgroundColor,
            borderTop: getComputedStyle(actions).borderTopWidth,
          }
        : null,
    };
  });
  await shot(page, 'card-390-dark-long-bottom');
  await setTheme(page, 'light');

  // ---- 空资料 ----
  await page.setViewportSize({ width: 390, height: 780 });
  await open('empty', 'card');
  await shot(page, 'card-390-light-empty');
  report.metrics.emptyCardText = await page.evaluate(
    () => document.querySelector('.weq-group-card')?.innerText ?? '',
  );
  await page.setViewportSize({ width: 1180, height: 900 });
  await open('empty', 'page');
  for (const tab of ['概览', '详细资料']) {
    await page
      .getByRole('navigation', { name: '群详情分区' })
      .getByRole('button', { name: tab, exact: true })
      .click();
    await page.waitForTimeout(500);
    await shot(page, `page-1180-light-empty-${tab}`);
  }
  report.metrics.emptyPageText = await page.evaluate(
    () => document.querySelector('.weq-contact-workspace-body')?.innerText.slice(0, 600) ?? '',
  );

  // ---- 加载中 ----
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto(`${base}?state=slow&view=card`);
  await page.locator('.weq-profile-hero').first().waitFor();
  await page.waitForTimeout(250);
  await shot(page, 'card-390-light-loading');
  report.metrics.loadingCardText = await page.evaluate(
    () => document.querySelector('.weq-group-card')?.innerText ?? '',
  );

  // ---- 错误 ----
  await open('error', 'card');
  await shot(page, 'card-390-light-error');
  report.metrics.errorCardText = await page.evaluate(
    () => document.querySelector('.weq-group-card')?.innerText ?? '',
  );

  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ shots: report.shots.length, errors: report.errors, issues: report.issues }),
  );
  console.log('METRICS', JSON.stringify(report.metrics, null, 1));
} finally {
  await browser?.close();
  await server.close();
}
