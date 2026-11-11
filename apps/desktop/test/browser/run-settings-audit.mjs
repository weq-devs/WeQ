import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-settings-audit'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/settings-audit.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});

const DIAG = `
(() => {
  const body = document.querySelector('.weq-settings-body') || document.querySelector('.weq-settings-pages');
  if (!body) return { missing: true };
  const text = (n) => (n?.textContent || '').trim().replace(/\\s+/g, ' ');
  const rows = [...body.querySelectorAll('.weq-set-row')].map((row) => {
    const label = text(row.querySelector('.weq-set-row-label'));
    const desc = text(row.querySelector('.weq-set-row-desc'));
    const ctrl = row.querySelector('.weq-set-row-ctrl');
    const el = ctrl?.firstElementChild;
    return {
      id: row.dataset.settingId || null,
      label,
      desc,
      control: el ? el.tagName.toLowerCase() + (el.className ? '.' + String(el.className) : '') : null,
      role: el?.getAttribute('role') || null,
      dis: el?.disabled ?? null,
    };
  });
  const cards = [...body.querySelectorAll('.weq-set-card')].map((card) => ({
    id: card.dataset.settingId || null,
    title: text(card.querySelector('.weq-set-card-title')),
    icon: Boolean(card.querySelector('.weq-set-card-icon')),
    reset: Boolean(card.querySelector('.weq-settings-reset-button')),
  }));
  const headers = [...body.querySelectorAll('.weq-set-head')].map((head) => ({
    title: text(head.querySelector('.weq-set-title')),
    desc: text(head.querySelector('.weq-set-desc')),
    icon: Boolean(head.querySelector('.weq-set-head-icon')),
    pageReset: Boolean(head.querySelector('.weq-settings-page-reset')),
    scope: text(head.querySelector('.weq-settings-scope')),
  }));
  const autosave = [...body.querySelectorAll('.weq-autosave-status')].map((n) => text(n));
  const stray = [...body.querySelectorAll('*')]
    .map((n) => String(n.className || ''))
    .flatMap((c) => c.split(/\\s+/))
    .filter((c) => c && !c.startsWith('weq-') && !c.startsWith('is-') && !c.startsWith('box-') && !c.startsWith('space-') && !c.startsWith('flex') && !c.startsWith('grid') && !c.startsWith('text-') && !c.startsWith('mt-') && !c.startsWith('mb-') && !c.startsWith('gap-') && !c.startsWith('px-') && !c.startsWith('py-') && !c.startsWith('w-') && !c.startsWith('h-') && !c.startsWith('rounded') && !c.startsWith('border') && !c.startsWith('bg-') && !c.startsWith('p-') && !c.startsWith('min-') && !c.startsWith('max-') && !c.startsWith('overflow') && !c.startsWith('relative') && !c.startsWith('absolute') && !c.startsWith('items-') && !c.startsWith('justify-') && !c.startsWith('shrink') && !c.startsWith('self-') && !c.startsWith('leading-') && !c.startsWith('font-') && !c.startsWith('truncate') && !c.startsWith('cursor-') && !c.startsWith('select-') && !c.startsWith('opacity') && !c.startsWith('transition') && !c.startsWith('hidden') && !c.startsWith('block') && !c.startsWith('inline') && !c.startsWith('col-') && !c.startsWith('row-') && !c.startsWith('order-') && !c.startsWith('place-') && !c.startsWith('sr-only'));
  return {
    headers,
    cards,
    rows,
    autosave,
    stray: [...new Set(stray)].sort(),
    overflowX: body.scrollWidth - body.clientWidth,
    bodyClass: body.className,
    h3: [...body.querySelectorAll('h3')].map(text),
    h4: [...body.querySelectorAll('h4')].map(text),
  };
})()
`;

let browser;
const report = { pages: [], interactions: [], errors: [] };
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_SETTINGS_AUDIT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const base = () =>
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-audit.html`;
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.clear());
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') report.errors.push(`console: ${msg.text()}`);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );

  const setTheme = async (theme) => {
    await page.evaluate((theme) => {
      window.settingsAuditQa.theme.getState().setPreference(theme);
      window.settingsAuditQa.theme.getState().setAccent(theme === 'light' ? '#b5243e' : '#81c995');
    }, theme);
  };
  const shot = async (name) => {
    if (output) await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: false });
  };
  const clickGroup = async (label) => {
    await page
      .locator('.weq-settings-nav')
      .getByRole('button', { name: label, exact: true })
      .click();
    await page.waitForTimeout(120);
  };
  const openSubnav = async (label) => {
    const item = page
      .locator('.weq-settings-subnav')
      .getByRole('button', { name: label, exact: true });
    if (!(await item.count())) return false;
    await item.click();
    await page.waitForTimeout(180);
    return true;
  };
  const activeId = () =>
    page.evaluate(() => {
      const el = document.querySelector('.weq-settings-subnav-item.is-active');
      return el ? el.textContent.trim() : null;
    });

  // ---- 1. 1280：整目录遍历（浅色出诊断，深色出截图） ----
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base()}?x=1`);
    await setTheme(theme);
    const groups = await page
      .locator('.weq-settings-nav-item .weq-settings-nav-label')
      .allTextContents();
    report.groups = groups.map((g) => g.trim());
    for (const group of groups) {
      await clickGroup(group.trim());
      const sections = await page.locator('.weq-settings-subnav-label').allTextContents();
      for (const section of sections) {
        const label = section.trim();
        if (!(await openSubnav(label))) continue;
        const slug = `${group.trim()}_${label}`.replace(/[^\w\u4e00-\u9fa5-]+/g, '-');
        await shot(`1280-${theme}-${slug}`);
        if (theme === 'light') {
          const diag = await page.evaluate(DIAG);
          report.pages.push({
            group: group.trim(),
            section: label,
            active: await activeId(),
            ...diag,
          });
        }
      }
    }
  }

  // ---- 2. 390：分类页 + 关键页 ----
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base()}?x=1`);
    await setTheme(theme);
    await page.waitForTimeout(250);
    await shot(`390-${theme}-categories`);
    const mobile = [];
    for (const [group, section, id] of [
      ['常规', '主题与背景', 'appearance'],
      ['基础功能', 'QQ 邮箱', 'mail'],
      ['基础功能', '联系人名片', 'contact-card'],
      ['基础功能', '消息显示', 'message-display'],
      ['关于 WeQ', '配置备份与恢复', 'backup'],
    ]) {
      await page.goto(`${base()}?section=${id}`);
      await setTheme(theme);
      await page.waitForTimeout(500);
      const slug = `390-${theme}-${group}_${section}`.replace(/[^\w\u4e00-\u9fa5-]+/g, '-');
      await shot(slug);
      if (theme === 'light') {
        const diag = await page.evaluate(DIAG);
        report.mobilePages = report.mobilePages || [];
        report.mobilePages.push({ group, section, ...diag });
      }
      mobile.push({ group, section, url: slug });
    }
    report[`mobile-${theme}`] = mobile;
  }

  // ---- 3. 交互：搜索落点 ----
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base()}?section=mail&settingId=mail-poll-interval`);
  await setTheme('light');
  await page.waitForTimeout(700);
  const search = await page.evaluate(() => {
    const target = document.querySelector('[data-search-highlight="true"]');
    const row = target?.closest('.weq-set-row') || null;
    const box = target?.getBoundingClientRect();
    return {
      highlighted: Boolean(target),
      settingId: row?.dataset.settingId ?? null,
      rect: box ? { top: Math.round(box.top), height: Math.round(box.height) } : null,
      focused:
        document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName,
      scrollTop: document.querySelector('.weq-settings-body')?.scrollTop ?? null,
      activeSection: document
        .querySelector('.weq-settings-subnav-item.is-active')
        ?.textContent?.trim(),
    };
  });
  report.interactions.push({ name: 'search-landing', ...search });
  await shot('interaction-search-mail-poll-interval');

  // ---- 4. 交互：自动保存（邮件查询间隔） ----
  const intervalInput = page.getByLabel('邮件查询间隔（分钟）', { exact: true }).first();
  await intervalInput.fill('5');
  await intervalInput.blur();
  await page.waitForTimeout(600);
  const afterEdit = await page.evaluate(() => ({
    status: [...document.querySelectorAll('.weq-autosave-status')].map((n) => n.textContent.trim()),
    value: document.querySelector('input[aria-label="邮件查询间隔（分钟）"]')?.value,
  }));
  report.interactions.push({ name: 'autosave-mail-interval', ...afterEdit });
  await shot('interaction-autosave-mail');

  // ---- 5. 交互：页面级重置弹窗 ----
  await page.goto(`${base()}?section=appearance`);
  await setTheme('light');
  await page.waitForTimeout(400);
  const pageReset = page.getByRole('button', { name: /恢复本页默认设置/ }).first();
  const resetCount = await page.getByRole('button', { name: /恢复.*默认设置/ }).count();
  report.interactions.push({ name: 'reset-buttons-on-appearance', count: resetCount });
  if (await pageReset.count()) {
    await pageReset.click();
    await page.waitForTimeout(300);
    report.interactions.push({
      name: 'reset-dialog',
      title: await page.locator('.weq-dialog-title').first().textContent(),
      buttons: await page.locator('.weq-dialog-layer button').allTextContents(),
    });
    await shot('interaction-reset-dialog');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    report.interactions.push({
      name: 'reset-dialog-esc',
      stillOpen: await page.locator('.weq-dialog-layer').count(),
      focusReturned: await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    });
  }

  // ---- 6. 交互：键盘 Tab 顺序 + 键盘顺序（邮箱页） ----
  await page.goto(`${base()}?section=mail`);
  await page.waitForTimeout(400);
  const tabs = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    tabs.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        return `${el.tagName.toLowerCase()}:${el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 18) || ''}`;
      }),
    );
  }
  report.interactions.push({ name: 'tab-order-mail', tabs });

  // ---- 7. 名片设置对比：类名与行结构 ----
  await page.goto(`${base()}?section=contact-card`);
  await setTheme('light');
  await page.waitForTimeout(500);
  const contactCard = await page.evaluate(() => {
    const body = document.querySelector('.weq-settings-body');
    return {
      classes: [
        ...new Set(
          [...body.querySelectorAll('*')].flatMap((n) => String(n.className || '').split(/\s+/)),
        ),
      ]
        .filter(Boolean)
        .sort(),
      gridOrCustom: {
        customRows: body.querySelectorAll('.weq-set-row').length,
        cards: body.querySelectorAll('.weq-set-card').length,
        headers: body.querySelectorAll('.weq-set-head').length,
      },
      headings: [...body.querySelectorAll('h3,h4,strong')]
        .map((n) => n.textContent.trim())
        .slice(0, 40),
    };
  });
  report.contactCard = contactCard;
  await shot('contrast-contact-card-1280-light');
  await setTheme('dark');
  await shot('contrast-contact-card-1280-dark');

  // ---- 8. 深色下的邮件页与重置弹窗 ----
  await page.goto(`${base()}?section=mail`);
  await setTheme('dark');
  await page.waitForTimeout(400);
  await shot('dark-mail-1280');

  // ---- 9. 回归断言：返回键、焦点环、搜索高亮、重置收敛 ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base()}?x=1`);
  await setTheme('light');
  await page.waitForTimeout(600);
  const state = () =>
    page.evaluate(() => ({
      dialog: Boolean(document.querySelector('.weq-settings-dialog')),
      categories: document.querySelector('.weq-settings-dialog')?.dataset.mobileCategory !== 'true',
      navVisible: (() => {
        const nav = document.querySelector('.weq-settings-nav');
        return Boolean(nav && nav.getBoundingClientRect().width > 0);
      })(),
    }));
  await page
    .locator('.weq-settings-nav')
    .getByRole('button', { name: '基础功能', exact: true })
    .click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '返回设置分类', exact: true }).click();
  await page.waitForTimeout(500);
  const afterBack = await state();
  assert.equal(afterBack.dialog, true, '返回设置分类不应退出设置');
  assert.equal(afterBack.navVisible, true, '返回设置分类后应回到一级分类列表');
  report.interactions.push({ name: 'mobile-back-to-categories', ...afterBack });
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      label: el.getAttribute('aria-label') || el.tagName,
      outline: style.outline,
      focusVisible: el.matches(':focus-visible'),
    };
  });
  report.interactions.push({ name: 'mobile-back-focus-ring', ...ring });
  assert(
    !String(ring?.outline || '').includes('0, 95, 204'),
    `焦点环不应是浏览器默认蓝色：${ring?.outline}`,
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base()}?section=message-display`);
  await page.waitForTimeout(500);
  const messageDisplayResets = await page.getByRole('button', { name: /恢复.*默认设置/ }).count();
  report.interactions.push({
    name: 'reset-buttons-on-message-display',
    count: messageDisplayResets,
  });
  assert.equal(messageDisplayResets, 1, '多卡片页面只保留一个页面级重置入口');

  await page.goto(`${base()}?section=mail&settingId=mail-poll-interval`);
  await page.waitForTimeout(700);
  const highlight = await page.evaluate(() => {
    const el = document.querySelector('[data-search-highlight="true"]');
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
      className: el.className,
      tag: el.tagName,
    };
  });
  report.interactions.push({ name: 'search-highlight-style', ...highlight });
  assert(
    highlight?.outlineStyle === 'none' || highlight?.outlineWidth === '0px',
    `搜索命中不应给整行描边：${JSON.stringify(highlight)}`,
  );

  await writeFile(resolve(output ?? '/tmp', 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pages: report.pages.length, errors: report.errors.slice(0, 8) }));
} finally {
  await browser?.close();
  await server.close();
}
