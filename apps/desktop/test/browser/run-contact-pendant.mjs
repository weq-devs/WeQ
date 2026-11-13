import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stub = resolve(root, 'test/browser/contact-card.stub.ts');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_CONTACT_PENDANT_QA;
const baseline = process.env.WEQ_CONTACT_PENDANT_BASELINE === '1';
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-contact-pendant'),
  plugins: [
    react(),
    tailwind(),
    {
      name: 'contact-pendant-baseline',
      load(id) {
        const path = id.slice(root.length + 1);
        if (baseline && path === 'src/renderer/src/styles/contact-card.css')
          return execFileSync('git', ['show', `HEAD:apps/desktop/${path}`], {
            cwd: root,
            encoding: 'utf8',
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
// QQ 装扮页 widget-face 使用 scale(.6)，custom-widget 占满同一舞台。
// 来源：https://zb.vip.qq.com/v2/pages/aioDressPage 的 widget-cube 样式。
// 合成圆孔遵循上游比例，不从待测 CSS 反推，避免与实现共享错误前提。
const widget = process.env.WEQ_CONTACT_PENDANT_IMAGE
  ? await readFile(process.env.WEQ_CONTACT_PENDANT_IMAGE)
  : await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="430" height="430"><circle cx="215" cy="215" r="138" fill="none" stroke="#e04a70" stroke-width="18"/><path d="M310 90L350 130L310 170L270 130Z" fill="#21a38b"/></svg>',
      ),
    )
      .png()
      .toBuffer();
const avatarImage = process.env.WEQ_CONTACT_PENDANT_AVATAR
  ? await readFile(process.env.WEQ_CONTACT_PENDANT_AVATAR)
  : await sharp({
      create: { width: 100, height: 100, channels: 4, background: '#85b9a2' },
    })
      .png()
      .toBuffer();
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
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.route('**/_media/dress?*', (route) => {
    if (new URL(page.url()).searchParams.has('broken'))
      return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'image/png', body: widget });
  });
  await page.route('**/resources/qqlevel/penguin.png', (route) =>
    route.fulfill({ contentType: 'image/png', body: avatarImage }),
  );
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-card.html`;
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      for (const variant of ['plain', 'pendant', 'broken']) {
        await page.goto(`${url}?${variant === 'plain' ? '' : 'pendant=1'}&${variant}=1`);
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'light' ? '#086d3d' : '#f1da83',
          );
        }, theme);
        for (const surface of ['card', 'page']) {
          if (surface === 'page') {
            await page.getByRole('button', { name: '打开完整资料页', exact: true }).click();
            await page.locator('.weq-contact-profile-content').waitFor();
            assert.equal(await page.locator('.weq-contact-card').count(), 0);
          }
          const button = page.locator('.weq-contact-identity .weq-profile-avatar');
          await button.waitFor().catch(async (error) => {
            console.error({
              width,
              theme,
              variant,
              surface,
              body: await page.locator('body').innerText(),
            });
            throw error;
          });
          if (variant === 'pendant')
            await button.locator('.weq-contact-pendant').evaluate((image) => image.decode());
          await button.locator('.avatar img').evaluate((image) => image.decode());
          if (variant === 'broken') {
            await page.waitForFunction(() =>
              window.contactCardQa.calls.some((call) => call.path === 'account.dressup.peerHome'),
            );
            await page.waitForFunction(() => !document.querySelector('.weq-contact-pendant'));
          }
          const layout = await button.evaluate((button) => {
            const avatar = button.querySelector('.avatar');
            const art = button.querySelector('.weq-contact-pendant');
            const rect = (element) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            };
            return {
              button: rect(button),
              avatar: rect(avatar),
              art: art ? rect(art) : null,
              radius: getComputedStyle(avatar).borderRadius,
              imageRadius: avatar.querySelector('img')
                ? getComputedStyle(avatar.querySelector('img')).borderRadius
                : null,
              heading: rect(button.nextElementSibling),
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          const label = `${width}/${theme}/${variant}/${surface}`;
          if (output) {
            await page.screenshot({ path: resolve(output, `${label.replaceAll('/', '-')}.png`) });
            if (layout.art)
              await page.screenshot({
                path: resolve(output, `${label.replaceAll('/', '-')}-avatar.png`),
                clip: {
                  x: layout.art.x - 4,
                  y: layout.art.y - 4,
                  width: layout.art.width + 8,
                  height: layout.art.height + 8,
                },
              });
          }
          assert.equal(layout.overflow, false, `${label}: 横向溢出`);
          assert.equal(layout.button.width, 64, `${label}: 按钮占位变化`);
          if (variant === 'pendant') {
            assert.ok(layout.art, `${label}: 缺少挂件`);
            assert.equal(layout.radius, '50%', `${label}: 头像不是圆形`);
            if (layout.imageRadius)
              assert.equal(layout.imageRadius, '50%', `${label}: 图片不是圆形`);
            assert.ok(
              Math.abs(layout.avatar.width / layout.art.width - 0.6) < 0.01,
              `${label}: 挂件与头像比例不匹配`,
            );
            for (const axis of ['x', 'y']) {
              const size = axis === 'x' ? 'width' : 'height';
              assert.ok(
                Math.abs(
                  layout.art[axis] +
                    layout.art[size] / 2 -
                    (layout.avatar[axis] + layout.avatar[size] / 2),
                ) < 0.1,
                `${label}: 挂件与头像不同心`,
              );
            }
            assert.ok(layout.art.x >= 0, `${label}: 挂件超出视口`);
            assert.ok(
              layout.art.x + layout.art.width <= layout.heading.x,
              `${label}: 挂件与标题重叠`,
            );
          } else {
            assert.equal(layout.art, null, `${label}: 普通头像残留挂件`);
            assert.equal(layout.avatar.width, 64, `${label}: 普通头像尺寸变化`);
            assert.equal(layout.radius, '14px', `${label}: 普通头像形状变化`);
          }
          cases++;
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
