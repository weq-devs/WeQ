import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.WEQ_PLAYWRIGHT_MODULE || 'playwright');
const renderer = new URL('../apps/desktop/src/renderer/src/', import.meta.url);
const files = [
  'styles/index.css',
  'styles/reminder-badge.css',
  'im-template/styles/base.css',
  'im-template/styles/rail.css',
  'im-template/styles/sidebar.css',
  'im-template/styles/screens.css',
  'im-template/styles/responsive.css',
  'styles/conversation-directory.css',
  'styles/conversation-list-row.css',
  'styles/rail-navigation.css',
  'styles/workspace-menu.css',
  'styles/contact-navigation.css',
  'styles/mail.css',
  'styles/mobile-web.css',
  'styles/qqnt-appearance.css',
  'styles/retro-appearance.css',
];
let browser;
let css;

before(async () => {
  css = (await Promise.all(files.map((file) => readFile(new URL(file, renderer), 'utf8')))).join(
    '\n',
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.WEQ_CHROMIUM_EXECUTABLE }
      : {}),
  });
});
after(async () => browser?.close());

function count(id, extra = '', tone = 'notice', overlay = false, tag = 'span') {
  return `<${tag} id="${id}" class="weq-reminder weq-reminder-count ${extra}${overlay ? ' weq-reminder-overlay' : ''}" data-tone="${tone}">99+</${tag}>`;
}

function dot(id, extra = '', overlay = false) {
  return `<span id="${id}" class="weq-reminder weq-reminder-dot ${extra}${overlay ? ' weq-reminder-overlay' : ''}"></span>`;
}

function fixture() {
  return `<main class="weq-web-shell"><div class="app-shell">
    <aside class="app-rail"><nav class="rail-nav">
      <div class="rail-message-entry"><button class="weq-rail-button rail-tab-messages" aria-label="消息"></button>${count('message', 'rail-badge rail-message-badge', 'notice', true, 'button')}</div>
      <button class="weq-rail-button">${count('rail-mail', 'rail-badge rail-badge-mail', 'notice', true)}</button>
      <button class="weq-rail-button">${dot('rail-dot', 'rail-badge rail-badge-dot', true)}</button>
    </nav><footer class="rail-footer"><button class="weq-rail-button weq-workspace-menu-trigger">
      ${count('menu', 'weq-workspace-dot weq-workspace-status-count is-finished', 'notice', true)}
    </button></footer></aside>
    <div class="conversation-row"><span class="row-main">Fixture</span><span class="row-meta">${count('conversation', 'row-unread')}</span></div>
    <div class="conversation-row active"><span class="row-main">Fixture</span><span class="row-meta">${count('conversation-active', 'row-unread')}</span></div>
    <div class="conversation-row"><span class="row-main">Fixture</span><span class="row-meta">${count('conversation-muted', 'row-unread muted', 'muted')}</span></div>
    <div class="weq-contact-directory"><button class="contact-row"><span class="avatar">A</span><span class="row-main">Fixture</span>${count('contact', 'row-unread')}</button>
    <button class="contact-row active"><span class="avatar">A</span><span class="row-main">Fixture</span>${count('contact-muted', 'row-unread muted', 'muted')}</button></div>
    ${count('running', 'weq-workspace-dot weq-workspace-status-count is-running', 'running', true)}
    ${dot('notice', 'notice-entry-dot')}${dot('update', 'weq-settings-update-mark')}${dot('mail', 'weq-mail-unread-dot')}
    <div class="weq-mobile-tab-icon">${count('mobile', 'weq-mobile-badge', 'notice', true)}</div>
    ${count('inline-mobile', 'weq-mobile-badge')}
    ${count('reference')}${count('reference-muted', '', 'muted')}${count('reference-running', '', 'running')}${dot('reference-dot')}
  </div></main>`;
}

for (const layout of ['desktop', 'single']) {
  for (const skin of ['default', 'qqnt', 'retro']) {
    for (const theme of ['light', 'dark']) {
      test(`${layout} / ${skin} / ${theme}：所有入口共用四种提醒样式`, async () => {
        const page = await browser.newPage({
          viewport: { width: layout === 'single' ? 390 : 1180, height: 900 },
        });
        try {
          await page.route('**/*', (route) => route.abort());
          await page.setContent(
            `<style>${css}</style><style>.app-shell{display:block}.weq-contact-directory{height:auto}.contact-row{width:260px}</style>${fixture()}`,
          );
          await page.evaluate(
            ({ layout, skin, theme }) => {
              Object.assign(document.documentElement.dataset, {
                weqLayout: layout,
                componentStyle: skin,
                density: 'comfortable',
                theme,
              });
            },
            { layout, skin, theme },
          );
          const styles = await page.locator('[id]').evaluateAll((nodes) =>
            Object.fromEntries(
              nodes.map((el) => {
                const s = getComputedStyle(el);
                return [
                  el.id,
                  {
                    background: s.backgroundColor,
                    color: s.color,
                    height: s.height,
                    fontSize: s.fontSize,
                    fontWeight: s.fontWeight,
                    radius: s.borderRadius,
                    border: s.borderWidth,
                    width: el.getBoundingClientRect().width,
                    rendered: el.getClientRects().length > 0,
                  },
                ];
              }),
            ),
          );
          const sameCount = (id, reference) => {
            for (const property of [
              'background',
              'color',
              'height',
              'fontSize',
              'fontWeight',
              'radius',
            ])
              assert.equal(styles[id][property], styles[reference][property], `${id}.${property}`);
            // 手机 Web 隐藏桌面 rail，仅检查仍在布局中的入口宽度。
            if (styles[id].rendered) assert.ok(styles[id].width >= 16, `${id} must fit its count`);
          };
          assert.equal(styles.message.background, styles.menu.background, '消息与菜单必须同色');
          for (const id of [
            'message',
            'rail-mail',
            'menu',
            'conversation',
            'conversation-active',
            'contact',
          ])
            sameCount(id, 'reference');
          for (const id of ['conversation-muted', 'contact-muted'])
            sameCount(id, 'reference-muted');
          sameCount('running', 'reference-running');
          if (layout === 'single')
            for (const id of ['mobile', 'inline-mobile']) sameCount(id, 'reference');
          for (const id of ['rail-dot', 'notice', 'update', 'mail']) {
            assert.equal(
              styles[id].background,
              styles['reference-dot'].background,
              `${id}.background`,
            );
            assert.equal(styles[id].height, '8px', `${id}.height`);
          }
          assert.equal(styles.reference.height, '16px');
          assert.equal(styles.reference.fontSize, '10px');
          assert.notEqual(styles.reference.background, styles['reference-muted'].background);
          assert.notEqual(styles.reference.background, styles['reference-running'].background);
          assert.equal(styles.message.border, '1px');
          assert.equal(styles.menu.border, '1px');
          assert.equal(styles.conversation.border, '0px');
          assert.equal(styles.contact.border, '0px');
          if (styles.message.rendered) {
            const badge = page.locator('#message');
            await badge.hover();
            await badge.focus();
            const interactive = await badge.evaluate((el) => {
              const s = getComputedStyle(el);
              const box = el.getBoundingClientRect();
              const text = document.createRange();
              text.selectNodeContents(el);
              const label = text.getBoundingClientRect();
              return {
                background: s.backgroundColor,
                height: s.height,
                color: s.color,
                fits:
                  label.left >= box.left && label.right <= box.right && label.bottom <= box.bottom,
              };
            });
            assert.equal(
              interactive.background,
              styles.reference.background,
              '悬停或聚焦不能抹掉红色',
            );
            assert.equal(interactive.height, '16px', '按钮角标不能被撑成导航按钮');
            assert.equal(interactive.color, styles.reference.color);
            assert.ok(interactive.fits, '99+ 必须完整容纳在角标里');
            await page.evaluate(() => {
              window.reminderClicks = { badge: 0, navigation: 0 };
              document
                .querySelector('#message')
                .addEventListener('click', () => window.reminderClicks.badge++);
              document
                .querySelector('.rail-tab-messages')
                .addEventListener('click', () => window.reminderClicks.navigation++);
            });
            await badge.click();
            await badge.press('Enter');
            assert.deepEqual(await page.evaluate(() => window.reminderClicks), {
              badge: 2,
              navigation: 0,
            });
          }
          const before = styles.reference.background;
          await page.evaluate(() =>
            document.documentElement.style.setProperty('--weq-accent-effective', '#f8e71c'),
          );
          assert.equal(
            await page.locator('#reference').evaluate((el) => getComputedStyle(el).backgroundColor),
            before,
          );
          assert.equal(
            await page.locator('#mail').evaluate((el) => getComputedStyle(el).backgroundColor),
            before,
          );
        } finally {
          await page.close();
        }
      });
    }
  }
}
