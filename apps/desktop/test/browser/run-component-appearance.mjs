import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const formsOnly = process.argv.includes('--forms-only');
const touch = process.argv.includes('--webkit-touch');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-component-appearance'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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

async function checkFormControls(page) {
  const press = (item) => (touch ? item.tap() : item.click());
  const open = page.getByRole('button', { name: '打开控件验证' });
  await press(open);
  const dialog = page.getByRole('dialog', { name: '表单控件验证' });
  const choice = dialog.getByRole('combobox', { name: /^选一个分组/ });
  const submit = dialog.getByRole('button', { name: '提交分组' });
  await press(submit);
  assert.equal(await choice.getAttribute('aria-invalid'), 'true');
  const options = dialog.getByRole('listbox', { name: '选项' });
  await options.waitFor();
  assert.equal(
    await options.getByRole('option', { name: '禁用分组' }).getAttribute('aria-disabled'),
    'true',
  );
  if (touch) await press(options.getByRole('option', { name: '乙组' }));
  else {
    await choice.press('ArrowDown');
    await choice.press('Enter');
  }
  assert.equal(await choice.getAttribute('data-value'), 'last');
  assert.equal(await dialog.getByLabel('变更次数').textContent(), '1');
  assert.equal(await dialog.getByLabel('提交结果').textContent(), '');
  await press(submit);
  assert.equal(await dialog.getByLabel('提交结果').textContent(), 'last');
  await press(choice);
  await choice.press('Escape');
  assert.equal(await choice.getAttribute('aria-expanded'), 'false');
  assert.equal(await dialog.isVisible(), true);

  const sender = dialog.getByRole('combobox', { name: '发送者' });
  await sender.fill('不在候选里的 UID');
  assert.equal(await sender.inputValue(), '不在候选里的 UID');
  await sender.fill('小明');
  const senderOption = dialog.getByRole('option', { name: /小明/ });
  if (touch) await press(senderOption);
  else {
    await sender.press('ArrowDown');
    await sender.press('Enter');
  }
  assert.equal(await sender.inputValue(), '10001');

  await press(dialog.getByRole('button', { name: /^筛选日期/ }));
  const date = page.getByRole('dialog', { name: '筛选日期' });
  const dateInput = date.getByRole('textbox', { name: '输入日期（年-月-日）' });
  await dateInput.fill('2026-02-31');
  assert.equal(await date.getByRole('button', { name: '确定', exact: true }).isEnabled(), false);
  await press(date.getByRole('button', { name: '2026-02-08', exact: true }));
  assert.equal(await date.isVisible(), false);
  assert.equal(
    await dialog.getByRole('button', { name: '筛选日期：2026-02-08' }).isVisible(),
    true,
  );

  const slider = dialog.getByRole('slider', { name: '清晰度' });
  await slider.press('ArrowRight');
  assert.equal(await slider.inputValue(), '31');
  assert.equal(
    await dialog.getByRole('progressbar', { name: '已知进度' }).getAttribute('value'),
    '30',
  );
  assert.equal(
    await dialog.getByRole('progressbar', { name: '未知进度' }).getAttribute('value'),
    null,
  );
  await press(dialog.getByRole('button', { name: '打开确认' }));
  await page.getByRole('dialog', { name: '验证确认框' }).waitFor();
  await page.keyboard.press('Enter');
  await dialog.getByText('已确认', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
}

try {
  await server.listen();
  browser = await (touch ? webkit : chromium).launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    reducedMotion: 'reduce',
    ...(touch ? { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } } : {}),
  });
  page.setDefaultTimeout(7500);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/component-appearance.html`;
  await page.goto(url);
  await page.waitForSelector('.conversation-row');
  await checkFormControls(page);
  const styles = await page.evaluate(() => window.appearanceQa.componentStyles);
  const output = process.env.WEQ_APPEARANCE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const failures = [];
  if (styles.map((style) => style.value).join(',') !== 'qqnt,classic,retro')
    failures.push('QQ NT 默认风格必须排在首位，后接简约、立体预设');
  const quick = process.argv.includes('--quick');
  let cases = 0;
  for (const width of formsOnly ? [] : quick ? [1280, 320] : [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 920 });
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      for (const background of quick
        ? ['plain']
        : ['plain', 'paper', 'grid', 'dots', 'wash', 'telegram']) {
        await page.evaluate(
          ({ theme, background }) => {
            const store = window.appearanceQa.store.getState();
            store.setPreference(theme);
            store.setBackground(background);
            const accent =
              background === 'plain'
                ? theme === 'light'
                  ? '#ffffff'
                  : '#000000'
                : background === 'dots'
                  ? theme === 'light'
                    ? '#000000'
                    : '#ffffff'
                  : background === 'grid'
                    ? '#8b5cf6'
                    : theme === 'light'
                      ? '#075c30'
                      : '#fff3a1';
            store.setAccent(accent);
          },
          { theme, background },
        );
        for (const { value, label } of styles) {
          await page.getByRole('radio', { name: label, exact: true }).click();
          for (const density of ['compact', 'comfortable']) {
            await page
              .getByRole('radio', { name: density === 'compact' ? '紧凑' : '舒适', exact: true })
              .click();
            await page.waitForTimeout(20);
            const checks = await page.evaluate(
              ({ value, density, width }) => {
                const css = (selector) => getComputedStyle(document.querySelector(selector));
                let qqntButtonsMatchClassic = true;
                if (value === 'qqnt') {
                  const signature = () =>
                    [...document.querySelectorAll('.appearance-controls button')].map((node) => {
                      const style = getComputedStyle(node);
                      return [
                        style.borderRadius,
                        style.borderWidth,
                        style.padding,
                        style.minHeight,
                        style.height,
                        style.fontSize,
                        style.lineHeight,
                        style.boxShadow,
                        style.transform,
                        style.filter,
                      ];
                    });
                  const actual = JSON.stringify(signature());
                  document.documentElement.dataset.componentStyle = 'classic';
                  try {
                    qqntButtonsMatchClassic = actual === JSON.stringify(signature());
                  } finally {
                    document.documentElement.dataset.componentStyle = value;
                  }
                }
                const row = document.querySelector('.conversation-row');
                const slot = row.parentElement;
                const avatar = row.querySelector('.avatar').getBoundingClientRect();
                const rowRect = row.getBoundingClientRect();
                const preview = `[data-component-preview="${value}"]:not([data-density-preview])`;
                const primary = css('.weq-set-btn-primary');
                const compositeBackground = (selector) => {
                  const nodes = [];
                  for (let node = document.querySelector(selector); node; node = node.parentElement)
                    nodes.unshift(node);
                  const ctx = document.createElement('canvas').getContext('2d');
                  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(
                    '--weq-bg-surface',
                  );
                  ctx.fillRect(0, 0, 1, 1);
                  for (const node of nodes) {
                    ctx.fillStyle = getComputedStyle(node).backgroundColor;
                    ctx.fillRect(0, 0, 1, 1);
                  }
                  return `#${[...ctx.getImageData(0, 0, 1, 1).data]
                    .slice(0, 3)
                    .map((v) => v.toString(16).padStart(2, '0'))
                    .join('')}`;
                };
                const pixel = (color) => {
                  const ctx = document.createElement('canvas').getContext('2d');
                  ctx.fillStyle = color;
                  ctx.fillRect(0, 0, 1, 1);
                  return `#${[...ctx.getImageData(0, 0, 1, 1).data]
                    .slice(0, 3)
                    .map((v) => v.toString(16).padStart(2, '0'))
                    .join('')}`;
                };
                const retroChecks =
                  value !== 'retro'
                    ? {}
                    : Object.fromEntries([
                        ...[
                          '.weq-segmented',
                          '.weq-segmented > button',
                          '.weq-collection-chip',
                          '.weq-collection-search',
                          '.weq-settings-nav-item',
                          '.weq-dress-card',
                          '.weq-workspace-menu',
                          '.weq-workspace-actions > button',
                          '.weq-hover-tooltip',
                        ].map((selector) => [
                          `retroRadius:${selector}`,
                          css(selector).borderRadius === '0px',
                        ]),
                        ['retroPopupBorder', css('.weq-workspace-menu').borderTopWidth === '2px'],
                        ['retroSearchWell', css('.weq-collection-search').boxShadow !== 'none'],
                        [
                          'retroSearchInner',
                          css('.weq-collection-search input').boxShadow === 'none',
                        ],
                        ['retroPageBorder', css('.weq-collection-dialog').borderTopWidth === '0px'],
                        ['retroPageShadow', css('.weq-collection-dialog').boxShadow === 'none'],
                        ...[
                          '.weq-segmented > button[aria-checked="true"]',
                          '.weq-collection-chip.is-active',
                          '.weq-settings-nav-item.is-active',
                        ].map((selector) => [
                          `retroSelection:${selector}`,
                          css(selector).backgroundColor === primary.backgroundColor &&
                            css(selector).color === primary.color,
                        ]),
                      ]);
                return {
                  ...retroChecks,
                  selected:
                    document.documentElement.dataset.componentStyle === value &&
                    document
                      .querySelector('.weq-style-option[aria-checked="true"]')
                      .getAttribute('aria-label') ===
                      window.appearanceQa.componentStyles.find((s) => s.value === value).label,
                  density: document.documentElement.dataset.density === density,
                  rowSize:
                    Math.abs(
                      row.getBoundingClientRect().height - slot.getBoundingClientRect().height,
                    ) < 1,
                  avatarFits: avatar.top >= rowRect.top && avatar.bottom <= rowRect.bottom,
                  expectedHeight:
                    row.getBoundingClientRect().height ===
                    (density === 'compact'
                      ? width <= 720
                        ? 64
                        : 54
                      : width <= 760
                        ? 76
                        : value === 'qqnt'
                          ? 64
                          : 62),
                  previewGeometry:
                    css('.weq-input').borderRadius ===
                    css(`${preview} .weq-style-preview-input`).borderRadius,
                  toggleGeometry:
                    value === 'classic' ||
                    css('.weq-set-toggle-track').borderRadius ===
                      css(`${preview} .weq-style-preview-toggle`).borderRadius,
                  previewPrimary: ['borderRadius', 'backgroundColor', 'color'].every(
                    (property) =>
                      css(`${preview} .weq-style-preview-button.is-primary`)[property] ===
                      primary[property],
                  ),
                  primaryContrast:
                    window.appearanceQa.contrastRatio(
                      pixel(primary.color),
                      compositeBackground('.weq-set-btn-primary'),
                    ) >= 4.5,
                  qqntButtonsMatchClassic,
                  selectionContrast:
                    window.appearanceQa.contrastRatio(
                      pixel(css('.conversation-row.active .row-main strong').color),
                      compositeBackground('.conversation-row.active'),
                    ) >= 4.5,
                  mergedStyle:
                    value !== 'classic' ||
                    (primary.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                      css('.conversation-row.active').backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                      css('.weq-settings-dialog .weq-set-card').borderTopWidth === '0px' &&
                      css('.weq-settings-dialog .weq-set-card').borderBottomWidth === '1px'),
                  retroContract:
                    value !== 'retro' ||
                    (primary.borderTopWidth === '2px' &&
                      css('.weq-input').borderTopWidth === '2px' &&
                      css('.weq-input').boxShadow !== 'none' &&
                      css('.weq-directory-scope-menu').borderTopWidth === '2px' &&
                      css('.conversation-row.active').backgroundColor === primary.backgroundColor),
                  qqntContract:
                    value !== 'qqnt' ||
                    (primary.borderRadius === '7px' &&
                      css('.weq-input').borderRadius === '8px' &&
                      css('.weq-directory-scope-menu').borderRadius === '8px' &&
                      css('.conversation-row.active').boxShadow ===
                        css(`${preview} .weq-style-preview-item.is-selected`).boxShadow),
                  noOverflow: document.documentElement.scrollWidth <= innerWidth,
                  previewVisible: [...document.querySelectorAll('.weq-style-preview')].every(
                    (node) =>
                      node.getBoundingClientRect().height >= 120 &&
                      node.scrollWidth <= node.clientWidth,
                  ),
                  optionsFit: [
                    ...document.querySelectorAll(
                      ':is([data-setting-id="component-style"], [data-setting-id="interface-density"]) .weq-style-option',
                    ),
                  ].every((option) => {
                    const label = option.querySelector('.weq-style-option-label > span');
                    return (
                      option.offsetTop === option.parentElement.firstElementChild.offsetTop &&
                      label.scrollWidth <= label.clientWidth
                    );
                  }),
                  disabled: css('button:disabled').backgroundColor !== primary.backgroundColor,
                };
              },
              { value, density, width },
            );
            for (const [check, passed] of Object.entries(checks))
              if (!passed)
                failures.push(`${width}/${theme}/${background}/${value}/${density}: ${check}`);
            cases++;
          }
          if (output && width === 1280 && background === (quick ? 'plain' : 'telegram'))
            await page.screenshot({
              path: resolve(output, `${theme}-${value}.png`),
              fullPage: true,
            });
        }
      }
    }
  }
  // 键盘、实际滚动、刷新恢复与系统模式同样走真实组件。
  const lastStyle = styles.at(-1);
  await page.getByRole('radio', { name: lastStyle.label, exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  if (
    (await page
      .getByRole('radio', { name: styles[0].label, exact: true })
      .getAttribute('aria-checked')) !== 'true'
  )
    failures.push('键盘循环选择');
  await page.keyboard.press('End');
  await page.getByRole('radio', { name: '紧凑', exact: true }).click();
  await page.locator('[data-weq-windowed-list]').evaluate((node) => {
    node.scrollTop = 5000;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  const aligned = await page
    .locator('.conversation-row')
    .evaluateAll((rows) =>
      rows.every(
        (row) =>
          row.getBoundingClientRect().height === row.parentElement.getBoundingClientRect().height,
      ),
    );
  if (!aligned) failures.push('滚动后虚拟行错位');
  await page.reload();
  await page.waitForSelector('.conversation-row');
  if (
    (await page
      .getByRole('radio', { name: lastStyle.label, exact: true })
      .getAttribute('aria-checked')) !== 'true'
  )
    failures.push('刷新风格恢复');
  if (
    (await page.getByRole('radio', { name: '紧凑', exact: true }).getAttribute('aria-checked')) !==
    'true'
  )
    failures.push('刷新密度恢复');
  await page.evaluate(() => window.appearanceQa.store.getState().setPreference('system'));
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  if (output) await page.screenshot({ path: resolve(output, 'mobile-qqnt.png'), fullPage: true });
  await page
    .getByRole('radio', {
      name: styles.find((style) => style.value === 'retro').label,
      exact: true,
    })
    .click();
  const scope = page.getByRole('radiogroup', { name: '内容范围' });
  await scope.getByRole('radio', { name: '全部内容', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  if (
    (await scope.getByRole('radio', { name: '已选内容' }).getAttribute('aria-checked')) !== 'true'
  )
    failures.push('立体风格分段控件键盘选择');

  // 同一套样式还需在真实聊天组件中成立，不能只对控件展示页生效。
  await page.goto(url.replace('component-appearance.html', 'qqnt-appearance.html'));
  await page.waitForSelector('.message-content');
  for (const width of formsOnly ? [] : [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 920 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        ({ theme }) => {
          const store = window.qqntQa.store.getState();
          store.setPreference(theme);
          store.setComponentStyle('retro');
          store.setBackground('telegram');
          store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        },
        { theme },
      );
      await page.waitForTimeout(30);
      const checks = await page.evaluate(() => {
        const css = (selector) => getComputedStyle(document.querySelector(selector));
        const content = document.querySelector('.message-content');
        const line = content.closest('.message-line');
        const signature = () => {
          const style = getComputedStyle(content);
          return [
            style.borderRadius,
            style.borderWidth,
            style.boxShadow,
            style.backgroundColor,
          ].join('|');
        };
        const unchanged = () => {
          document.documentElement.dataset.componentStyle = 'classic';
          const classic = signature();
          document.documentElement.dataset.componentStyle = 'retro';
          return signature() === classic;
        };
        const originalBubble = line.getAttribute('data-bubble');
        line.setAttribute('data-bubble', 'synthetic');
        const decoratedBubble = unchanged();
        if (originalBubble === null) line.removeAttribute('data-bubble');
        else line.setAttribute('data-bubble', originalBubble);
        const media = [
          'sticker-only',
          'qq-card-only',
          'qq-voice-only',
          'markdown-image-only',
          'code-only',
        ].every((className) => {
          content.classList.add(className);
          try {
            return unchanged();
          } finally {
            content.classList.remove(className);
          }
        });
        return {
          decoratedBubble,
          media,
          rail: css('.weq-rail-button').borderRadius === '0px',
          railSelected:
            css('.weq-rail-button[aria-current="page"]').backgroundColor ===
            css('.conversation-row.active').backgroundColor,
          bubble:
            css('.message-content').borderRadius === '0px' &&
            css('.message-content').borderTopWidth === '1px',
          avatar: css('.message-line .avatar').borderRadius === '0px',
          editor: css('.composer-editor').boxShadow !== 'none',
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
        };
      });
      for (const [check, passed] of Object.entries(checks))
        if (!passed) failures.push(`chat/${width}/${theme}: ${check}`);
      if (output)
        await page.screenshot({ path: resolve(output, `retro-chat-${theme}-${width}.png`) });
      cases++;
    }
  }
  console.log(
    JSON.stringify(
      { formControls: touch ? 'WebKit touch' : 'Chromium keyboard', cases, failures, errors },
      null,
      2,
    ),
  );
  if (failures.length || errors.length) throw new Error([...failures, ...errors].join('\n'));
} finally {
  await browser?.close();
  await server.close();
}
