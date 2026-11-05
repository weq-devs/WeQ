import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serve = process.argv.includes('--serve');
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
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qqnt-appearance.html`;
console.log(`QQ NT preview: ${url}`);

if (serve) {
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
      await server.close();
      process.exit(0);
    });
} else {
  const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.WEQ_BROWSER_EXECUTABLE
        ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
        : {}),
    });
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ||
      route.request().url().startsWith('data:')
        ? route.continue()
        : route.abort(),
    );
    const output = process.env.WEQ_APPEARANCE_ARTIFACTS;
    if (output) await mkdir(output, { recursive: true });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('.message-content').catch(async (error) => {
      console.error(JSON.stringify({ errors, body: await page.locator('body').innerText() }));
      if (output) await page.screenshot({ path: resolve(output, 'fixture-error.png') });
      throw error;
    });
    const failures = [];
    let cases = 0;
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        for (const accent of ['', '#fff3a1', '#075c30', '#000000', '#ffffff']) {
          await page.evaluate(
            ({ theme, accent }) => {
              const store = window.qqntQa.store.getState();
              store.setPreference(theme);
              store.setAccent(accent);
            },
            { theme, accent },
          );
          const checks = await page.evaluate(() => {
            const style = (selector) => getComputedStyle(document.querySelector(selector));
            const ctx = document.createElement('canvas').getContext('2d');
            const pixel = (color) => {
              ctx.clearRect(0, 0, 1, 1);
              ctx.fillStyle = color;
              ctx.fillRect(0, 0, 1, 1);
              return `#${[...ctx.getImageData(0, 0, 1, 1).data]
                .slice(0, 3)
                .map((v) => v.toString(16).padStart(2, '0'))
                .join('')}`;
            };
            const contrast = (selector) =>
              window.qqntQa.contrastRatio(
                pixel(style(selector).color),
                pixel(style(selector).backgroundColor),
              );
            const mine = '.message-line.mine .message-content';
            return {
              noOverflow: document.documentElement.scrollWidth <= innerWidth,
              bubbleGeometry: style(mine).borderRadius === '12px',
              bubbleContrast: contrast(mine) >= 4.5,
              noBlur: style('.chat-header').backdropFilter === 'none',
              headerHeight:
                document.querySelector('.chat-header').getBoundingClientRect().height ===
                (innerWidth <= 760 &&
                document.querySelector(
                  '.chat-header-roaming-action, .weq-conversation-message-actions',
                )
                  ? 84
                  : 52),
              messageFits: [...document.querySelectorAll('.message-content')].every((node) => {
                const box = node.getBoundingClientRect();
                return (
                  box.left >= 0 &&
                  box.right <= innerWidth &&
                  node.scrollWidth <= node.clientWidth + 1
                );
              }),
              touchTarget:
                innerWidth > 760 ||
                [...document.querySelectorAll('.composer-tools .composer-mobile-tool')]
                  .filter((node) => node.getBoundingClientRect().height > 0)
                  .every((node) => node.getBoundingClientRect().height >= 44),
            };
          });
          for (const [name, passed] of Object.entries(checks))
            if (!passed) failures.push(`${width}/${theme}/${accent || 'default'}: ${name}`);
          if (output && accent === '')
            await page.screenshot({
              path: resolve(output, `${width}-${theme}-chat.png`),
              fullPage: true,
            });
          cases++;
        }
      }
    }
    await page.goto(`${url}?assistant`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('.weq-conversation-list .conversation-row');
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        for (const preset of ['classic', 'minimal', 'retro', 'qqnt']) {
          for (const density of ['comfortable', 'compact']) {
            await page.evaluate(
              ({ theme, preset, density }) => {
                const store = window.qqntQa.store.getState();
                store.setPreference(theme);
                store.setComponentStyle(preset);
                store.setDensity(density);
              },
              { theme, preset, density },
            );
            await page.waitForTimeout(30);
            const comparison = await page.evaluate(() => {
              const metrics = (base) => {
                const row = document.querySelector(`${base} .conversation-row`);
                const css = getComputedStyle(row);
                const read = (part, property) =>
                  getComputedStyle(row.querySelector(part))[property];
                return {
                  height: css.height,
                  padding: css.padding,
                  gap: css.gap,
                  avatar: read('.avatar', 'width'),
                  title: read('.row-main strong', 'fontSize'),
                  titleLine: read('.row-main strong', 'lineHeight'),
                  preview: read('.row-preview-line', 'fontSize'),
                  time: read('.row-meta', 'fontSize'),
                  unreadBorder: read('.row-unread', 'borderWidth'),
                };
              };
              const main = metrics('.app-shell');
              const assistant = metrics('.weq-conversation-list');
              const row = document.querySelector('.weq-conversation-list .conversation-row');
              const title = row.querySelector('.row-main strong').getBoundingClientRect();
              const time = row.querySelector('.row-time-line').getBoundingClientRect();
              return { main, assistant, titleTimeAligned: Math.abs(title.top - time.top) <= 1 };
            });
            for (const property of Object.keys(comparison.main))
              if (comparison.main[property] !== comparison.assistant[property])
                failures.push(
                  `群助手 ${width}/${theme}/${preset}/${density}/${property}: ${comparison.main[property]} != ${comparison.assistant[property]}`,
                );
            if (
              preset === 'qqnt' &&
              (!comparison.titleTimeAligned || comparison.assistant.unreadBorder !== '0px')
            )
              failures.push(`群助手 ${width}/${theme}/${density}: 时间对齐或未读描边`);
            if (output && preset === 'qqnt' && density === 'comfortable')
              await page.screenshot({
                path: resolve(output, `${width}-${theme}-assistant.png`),
                fullPage: true,
              });
            cases++;
          }
        }
      }
    }
    let reference;
    if (process.env.WEQ_QQNT_REFERENCE) {
      const css = await readFile(process.env.WEQ_QQNT_REFERENCE, 'utf8');
      const source = await browser.newPage();
      await source.setContent(
        '<button class="q-button">保存</button><div class="q-input"><input /></div><div class="msg-content-container">消息</div>',
      );
      await source.addStyleTag({ content: css });
      // 消息容器规则来自另外的分块，单独记录，不把它伪装成 pcqqkit 中的规则。
      const metrics = await source.locator('.q-button').evaluate((node) => {
        const s = getComputedStyle(node);
        return {
          radius: s.borderRadius,
          fontSize: s.fontSize,
          lineHeight: s.lineHeight,
          padding: s.padding,
        };
      });
      const inputRadius = await source
        .locator('.q-input')
        .evaluate((node) => getComputedStyle(node).borderRadius);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => window.qqntQa.store.getState().setDensity('comfortable'));
      const actual = await page.locator('.composer-send').evaluate((node) => {
        const s = getComputedStyle(node);
        return {
          radius: s.borderRadius,
          fontSize: s.fontSize,
          lineHeight: s.lineHeight,
          padding: s.padding,
        };
      });
      for (const name of Object.keys(metrics))
        if (actual[name] !== metrics[name])
          failures.push(`QQ CSS 对照 ${name}: ${actual[name]} != ${metrics[name]}`);
      reference = {
        file: process.env.WEQ_QQNT_REFERENCE,
        sha256: createHash('sha256').update(css).digest('hex'),
        button: metrics,
        inputRadius,
        actualButton: actual,
      };
      await source.close();
    }
    await page.goto(`${url}?contacts`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('.sidebar-header-contacts .weq-directory-toolbar');
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => window.qqntQa.store.getState().setPreference(theme), theme);
        const checks = await page.evaluate(() => {
          const sidebar = document.querySelector('.sidebar');
          const toolbar = document.querySelector('.sidebar-header-contacts .weq-directory-toolbar');
          const tools = getComputedStyle(
            document.querySelector('.sidebar-header-contacts .contact-tools'),
          );
          const box = toolbar.getBoundingClientRect();
          return {
            sameSurface: getComputedStyle(toolbar).backgroundColor === 'rgba(0, 0, 0, 0)',
            noOuterMargin: tools.marginLeft === '0px' && tools.marginRight === '0px',
            fullWidth: Math.abs(box.width - sidebar.clientWidth) <= 1,
            aligned: Math.abs(box.left - sidebar.getBoundingClientRect().left) <= 1,
            noOverflow: document.documentElement.scrollWidth <= innerWidth,
          };
        });
        for (const [name, passed] of Object.entries(checks))
          if (!passed) failures.push(`联系人 ${width}/${theme}: ${name}`);
        if (output)
          await page.screenshot({
            path: resolve(output, `${width}-${theme}-contacts.png`),
            fullPage: true,
          });
        cases++;
      }
    }
    const report = { cases, failures, errors, reference };
    if (output)
      await writeFile(resolve(output, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    if (failures.length || errors.length) throw new Error('QQ NT 外观对照未通过');
  } finally {
    await browser?.close();
    await server.close();
  }
}
