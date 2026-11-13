import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_CARD_SCROLL_QA;
const results = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'],
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  if (output) await mkdir(output, { recursive: true });
  for (const fixture of ['contact-card', 'group-card-refactor']) {
    const stub = resolve(root, `test/browser/${fixture}.stub.ts`);
    const server = await createServer({
      configFile: false,
      root,
      plugins: [react(), tailwind()],
      define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
      resolve: {
        alias: [
          { find: /^.*\/trpc\/client$/, replacement: stub },
          ...(fixture === 'contact-card'
            ? [{ find: /^.*\/hooks\/useQQWriteSession$/, replacement: stub }]
            : []),
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
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.route('**/_media/album?*', async (route) => {
      await route.fulfill({
        contentType: 'image/png',
        body: await readFile(resolve(root, '../../resources/qqlevel/penguin.png')),
      });
    });
    try {
      await server.listen();
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/${fixture}.html?photos=1`,
      );
      const card = page.locator('.weq-member-pop.weq-contact-card').first();
      await card.waitFor();
      if (fixture === 'contact-card') {
        await page.evaluate(() => {
          const qa = window.contactCardQa;
          qa.configure({ ...qa.settings, visible: { ...qa.settings.visible, photos: true } });
        });
        await card.locator('.weq-profile-photo').last().waitFor({ state: 'attached' });
      }
      await page.waitForTimeout(300);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 600 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.setProperty(
              '--weq-accent-effective',
              theme === 'dark' ? '#47bc97' : '#c64556',
            );
          }, theme);
          const layout = await card.evaluate((node) => {
            const body = node.querySelector('.weq-contact-card-body');
            const style = getComputedStyle(body);
            const bodyBounds = body.getBoundingClientRect();
            const actions = node.querySelector('.weq-profile-card-actions');
            const footerBefore = actions.getBoundingClientRect();
            node.scrollLeft = 1000;
            node.scrollTop = node.scrollHeight;
            body.scrollLeft = 1000;
            body.scrollTop = body.scrollHeight;
            const bodyScrollTop = body.scrollTop;
            const bounds = node.getBoundingClientRect();
            const footer = actions.getBoundingClientRect();
            const contentRight =
              bodyBounds.left + body.clientWidth - parseFloat(style.paddingRight);
            const album = body.querySelector('.weq-profile-album');
            const photos = album
              ? [...album.children].map((photo) => photo.getBoundingClientRect())
              : [];
            const content = body.firstElementChild;
            const widthBefore = content.getBoundingClientRect().width;
            const previousHeight = body.style.height;
            const previousFlex = body.style.flex;
            // 同一正文从需要滚动变为不需要滚动时，内容宽度不应改变。
            body.style.flex = 'none';
            body.style.height = `${body.scrollHeight + 1}px`;
            const withoutOverflow = body.scrollHeight <= body.clientHeight;
            const widthWithoutOverflow = content.getBoundingClientRect().width;
            body.style.height = previousHeight;
            body.style.flex = previousFlex;
            body.scrollTop = bodyScrollTop;
            return {
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
              scrollLeft: node.scrollLeft,
              scrollTop: node.scrollTop,
              bodyScrollTop,
              bodyScrollLeft: body.scrollLeft,
              bodyFits: body.scrollWidth === body.clientWidth,
              gutter: style.scrollbarGutter,
              reservedWidth: body.offsetWidth - body.clientWidth,
              paddingRight: parseFloat(style.paddingRight),
              trackWidth: getComputedStyle(body, '::-webkit-scrollbar').width,
              thumbBorder: getComputedStyle(body, '::-webkit-scrollbar-thumb').borderRightWidth,
              withoutOverflow,
              widthBefore,
              widthWithoutOverflow,
              photosFit: photos.every((photo) => photo.right <= contentRight + 0.5),
              photoColumns: album
                ? getComputedStyle(album).gridTemplateColumns.split(' ').length
                : 0,
              footerFixed: footer.top === footerBefore.top && footer.bottom === footerBefore.bottom,
              bodyAboveFooter: bodyBounds.bottom <= footer.top + 0.5,
              footerFits: footer.left >= bounds.left && footer.right <= bounds.right,
              footerVisible: footer.top >= bounds.top && footer.bottom <= bounds.bottom,
            };
          });
          results.push({ fixture, width, theme, ...layout });
          assert.equal(layout.scrollWidth, layout.clientWidth, JSON.stringify(results.at(-1)));
          assert.equal(layout.scrollLeft, 0, '名片不应横向滚动');
          assert.equal(layout.scrollTop, 0, '名片外壳不应滚动');
          assert.ok(layout.bodyScrollTop > 0, '长名片正文仍应支持纵向滚动');
          assert.equal(layout.bodyScrollLeft, 0);
          assert.ok(layout.bodyFits, '正文不应横向溢出');
          assert.equal(layout.gutter, 'stable', '名片应始终为滚动条留槽');
          assert.equal(layout.reservedWidth, 12, '应实际预留 12px 滚动条槽');
          assert.ok(layout.paddingRight >= 8, '内容与滚动条之间至少保留 8px');
          assert.equal(layout.trackWidth, '12px');
          assert.equal(layout.thumbBorder, '3px', '12px 槽内的滑块应为 6px 宽');
          assert.ok(layout.withoutOverflow, '应实际覆盖无需滚动的状态');
          assert.equal(layout.widthBefore, layout.widthWithoutOverflow, '滚动状态切换不应挤动内容');
          assert.ok(layout.photosFit, '精选照片不应侵入滚动条区域');
          if (fixture === 'contact-card') assert.equal(layout.photoColumns, 3);
          assert.ok(layout.footerFixed && layout.bodyAboveFooter, '正文滚动不应影响底部操作栏');
          assert.ok(layout.footerFits && layout.footerVisible, '底部操作栏应完整可见');
          if (fixture === 'contact-card') {
            await card.locator('.weq-profile-photo').last().scrollIntoViewIfNeeded();
            await card
              .locator('.weq-profile-photo img')
              .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
          }
          const bodyBounds = await card.locator('.weq-contact-card-body').boundingBox();
          await page.mouse.move(
            bodyBounds.x + bodyBounds.width - 6,
            bodyBounds.y + bodyBounds.height / 2,
          );
          if (output)
            await page.screenshot({ path: resolve(output, `${fixture}-${width}-${theme}.png`) });
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
      await server.close();
    }
  }
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  await browser?.close();
}
