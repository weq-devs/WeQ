import { createServer } from 'vite';
import tailwind from '@tailwindcss/vite';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-form-controls'),
  plugins: [tailwind()],
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
const nativeFields = [
  ['设置', '<input class="weq-set-input">'],
  ['通用表单', '<div class="form-field"><input></div>'],
  ['日期时间', '<input class="weq-composition-time" type="datetime-local">'],
  ['聊天记录搜索', '<input class="weq-search-more-input">'],
  ['消息筛选', '<select class="weq-msglist-select"><option>全部成员</option></select>'],
  ['转发正文', '<textarea class="weq-mf-textarea"></textarea>'],
  ['群关键词', '<input class="group-keyword-input">'],
  ['空间帐号', '<div class="weq-qzn-navigation"><input></div>'],
  ['说说正文', '<div class="weq-qzn-composer"><textarea></textarea></div>'],
  ['SQL', '<textarea class="weq-cache-sql-input"></textarea>'],
  ['Hex', '<textarea class="weq-blob-bulk-input"></textarea>'],
  ['AI 语音', '<textarea class="ai-voice-textarea"></textarea>'],
  ['链接描述', '<div class="link-card-field"><textarea></textarea></div>'],
  ['ARK', '<textarea class="ark-json"></textarea>'],
  ['闪传', '<input class="flash-lightbox-input">'],
  ['只读会话搜索', '<form class="weq-conversation-notice"><input></form>'],
  ['密码', '<input class="weq-password-input" type="password">'],
];
const containers = [
  'search-box',
  'weq-dress-search',
  'weq-collection-search',
  'weq-msglist-search',
  'weq-face-search',
  'weq-mf-search',
  'weq-mf-mall-search',
  'weq-gift-search',
  'weq-redpack-wall-search',
  'weq-grouppick-search',
  'weq-rank-search',
  'ark-search',
  'emoji-lb-search',
  'link-card-input',
  'bounce-search',
  'redpacket-input-wrap',
  'redpacket-stepper',
  'weq-keyfield-input',
  'weq-set-keyfield',
  'weq-onebot-token-input',
];
const styles = [
  'index',
  'component-appearance',
  'qqnt-appearance',
  'retro-appearance',
  'dressup',
  'composition-time',
  'qzone',
  'cache',
  'gift-mall',
  'redpack-wall',
  'settings-onebot',
];
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route(`${origin}/form-controls`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body></body></html>',
    }),
  );
  await page.goto(`${origin}/form-controls`);
  // 先加载修复，再加载业务样式，验证懒加载页面也不能把状态颜色改回去。
  if (!process.env.WEQ_FORM_BASELINE)
    await page.addStyleTag({ url: `${origin}/src/renderer/src/styles/form-controls.css?direct` });
  for (const style of styles)
    await page.addStyleTag({ url: `${origin}/src/renderer/src/styles/${style}.css?direct` });
  await page.addStyleTag({
    url: `${origin}/src/renderer/src/components/relationGraph/relationGraph.css?direct`,
  });
  await page.addStyleTag({
    content: `
    body { margin: 0; padding: 16px; background: var(--weq-bg-app); }
    #fixtures { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .sample { min-width: 0; display: grid; gap: 6px; color: var(--weq-fg-primary); }
    .sample > div { min-width: 0; }
    .sample input, .sample textarea, .sample select { max-width: 100%; }
    .sample input:not([type='checkbox']) { width: 100%; }
    .sample .weq-dress-search { margin-left: 0; }
    .sample input.weq-search-more-input { width: calc(100% - 36px); }
    .sample, .sample * { transition: none; animation: none; }
  `,
  });
  await page.evaluate(
    ({ nativeFields, containers }) => {
      const fixtures = document.createElement('main');
      fixtures.id = 'fixtures';
      const entries = [
        ...nativeFields.map(([name, html]) => ({ name, html, wrapped: false })),
        ...containers.map((cls) => ({
          name: cls,
          html: `<div class="${cls}"><input></div>`,
          wrapped: true,
        })),
      ];
      for (const entry of entries)
        for (const state of ['enabled', 'readonly', 'disabled']) {
          if (state === 'readonly' && entry.html.includes('<select')) continue;
          const sample = document.createElement('section');
          sample.className = 'sample';
          sample.dataset.state = state;
          sample.dataset.wrapped = String(entry.wrapped);
          sample.innerHTML = `<span>${entry.name} · ${state}</span><div>${entry.html}</div>`;
          const field = sample.querySelector('input,textarea,select');
          field.placeholder = '请输入内容';
          if (field.type === 'datetime-local') field.value = '2026-11-13T14:00';
          else if (field.tagName !== 'SELECT') field.value = '已填写的内容';
          if (state === 'disabled') field.disabled = true;
          if (state === 'readonly') field.readOnly = true;
          fixtures.append(sample);
        }
      fixtures.insertAdjacentHTML(
        'beforeend',
        '<section class="sample"><button class="weq-asst-select"><span class="weq-asst-select-value">已选模型</span></button></section>',
      );
      fixtures.insertAdjacentHTML(
        'beforeend',
        '<section class="sample" data-state="disabled"><fieldset disabled><input class="weq-set-input" value="父级禁用"></fieldset></section>',
      );
      fixtures.insertAdjacentHTML(
        'beforeend',
        '<section class="sample"><div class="weq-set-row-ctrl"><input type="checkbox" checked></div></section>',
      );
      document.body.append(fixtures);
    },
    { nativeFields, containers },
  );
  const output = process.env.WEQ_FORM_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const skin of ['qqnt', 'classic', 'minimal', 'retro'])
    for (const theme of ['light', 'dark'])
      for (const accent of ['#075c30', '#fff3a1'])
        for (const width of [1180, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(
            ({ skin, theme, accent }) => {
              document.documentElement.dataset.componentStyle = skin;
              document.documentElement.dataset.theme = theme;
              document.documentElement.style.setProperty('--weq-accent-effective', accent);
              document.documentElement.style.setProperty(
                '--weq-accent-ink',
                theme === 'light' ? '#075c30' : '#fff3a1',
              );
            },
            { skin, theme, accent },
          );
          const failures = await page.evaluate(() => {
            const failures = [];
            const probe = document.createElement('span');
            document.body.append(probe);
            const resolve = (property, token) => {
              probe.style[property] = `var(${token})`;
              return getComputedStyle(probe)[property];
            };
            for (const sample of document.querySelectorAll('.sample[data-state]')) {
              const field = sample.querySelector('input,textarea,select');
              const state = sample.dataset.state;
              const surface = sample.dataset.wrapped === 'true' ? field.parentElement : field;
              const fg = resolve(
                'color',
                state === 'disabled' ? '--weq-fg-secondary' : '--weq-fg-primary',
              );
              const bg = resolve(
                'backgroundColor',
                state === 'enabled'
                  ? '--weq-bg-surface'
                  : state === 'disabled'
                    ? '--muted'
                    : document.documentElement.dataset.theme === 'dark'
                      ? '--weq-bg-app'
                      : '--weq-bg-elevated',
              );
              if (
                getComputedStyle(field).color !== fg ||
                getComputedStyle(surface).backgroundColor !== bg
              )
                failures.push({
                  name: sample.textContent,
                  fg: getComputedStyle(field).color,
                  expectedFg: fg,
                  bg: getComputedStyle(surface).backgroundColor,
                  expectedBg: bg,
                });
              if (
                sample.dataset.wrapped === 'true' &&
                getComputedStyle(field).backgroundColor !== 'rgba(0, 0, 0, 0)'
              )
                failures.push({ name: sample.textContent, error: 'nested-background' });
            }
            const normalBg = resolve('backgroundColor', '--weq-bg-surface');
            const disabledBg = resolve('backgroundColor', '--muted');
            if (normalBg === disabledBg)
              failures.push({ error: 'identical-enabled-disabled-background' });
            if (
              getComputedStyle(document.querySelector('.weq-asst-select-value')).color !==
              resolve('color', '--weq-fg-primary')
            )
              failures.push({ error: 'selected-model-muted' });
            if (!document.querySelector('fieldset input').matches(':disabled'))
              failures.push({ error: 'fieldset-state-lost' });
            probe.remove();
            if (document.documentElement.scrollWidth > innerWidth)
              failures.push({
                error: 'horizontal-overflow',
                elements: [...document.querySelectorAll('.sample *')]
                  .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
                  .slice(0, 5)
                  .map((e) => ({ cls: e.className, width: e.getBoundingClientRect().width })),
              });
            return failures;
          });
          assert.equal(
            failures.length,
            0,
            JSON.stringify({
              skin,
              theme,
              accent,
              width,
              failures: failures.slice(0, 6),
              total: failures.length,
            }),
          );
          cases++;
          if (output && accent === '#075c30' && width !== 390)
            await page.screenshot({
              path: resolve(output, `${skin}-${theme}-${width}.png`),
              fullPage: true,
            });
        }
  const input = page.locator('.sample[data-state="enabled"] .weq-set-input').first();
  await input.fill('正常编辑');
  await input.press('Tab');
  assert.equal(await input.inputValue(), '正常编辑');
  await input.focus();
  assert.equal(
    await input.evaluate((element) => getComputedStyle(element).borderBottomColor),
    'rgb(255, 243, 161)',
  );
  await input.evaluate((element) => element.setAttribute('aria-invalid', 'true'));
  assert.notEqual(
    await input.evaluate((element) => getComputedStyle(element).borderBottomColor),
    'rgb(255, 243, 161)',
  );
  const search = page.locator('.sample[data-state="enabled"] .weq-dress-search input');
  await search.focus();
  assert.equal(
    await search.evaluate((element) => getComputedStyle(element.parentElement).borderBottomColor),
    'rgb(255, 243, 161)',
  );
  const checkbox = page.locator('[type="checkbox"]');
  await checkbox.uncheck();
  assert.equal(await checkbox.isChecked(), false);
  console.log(
    JSON.stringify({
      cases,
      fields: nativeFields.length + containers.length,
      checks: [
        'state-colors',
        'nested-transparency',
        'selected-model',
        'fieldset-disabled',
        'responsive',
        'editing',
        'focus',
      ],
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
