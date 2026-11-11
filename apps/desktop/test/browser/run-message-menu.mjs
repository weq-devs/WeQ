import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/hooks\/useVoiceTranscription$/,
        replacement: resolve(root, 'test/browser/message-menu.stub.ts'),
      },
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/message-menu.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
const check = (condition, text) => {
  if (!condition) throw new Error(text);
};
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_STYLE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fallback = await sharp({
    create: { width: 26, height: 26, channels: 3, background: '#21a266' },
  })
    .png()
    .toBuffer();
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/_asset/emoji/')) {
      const rel = url.pathname.slice('/_asset/emoji/'.length);
      const body = process.env.WEQ_EMOJI_FIXTURE_DIR
        ? await readFile(resolve(process.env.WEQ_EMOJI_FIXTURE_DIR, rel)).catch(() => fallback)
        : fallback;
      return route.fulfill({ contentType: 'image/png', body });
    }
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/message-menu.html`,
  );
  await page.waitForFunction(() => window.menuFixture);
  for (const [theme, width, height, accent, background] of [
    ['light', 1280, 900, '#19764c', 'plain'],
    ['dark', 1280, 900, '#f4cf4c', 'grid'],
    ['light', 390, 844, '#db3f62', 'paper'],
    ['dark', 390, 844, '#b7dfdd', 'dots'],
    ['light', 640, 280, '#19764c', 'plain'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [corner, x, y] of [
      ['top-left', 0, 0],
      ['top-right', width, 0],
      ['bottom-left', 0, height],
      ['bottom-right', width, height],
    ]) {
      await page.evaluate(
        (args) => window.menuFixture(...args),
        [x, y, width < 760, theme, accent, background],
      );
      const menu = page.getByRole('menu');
      await menu.waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.message-reaction-strip img')].every(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      );
      const geometry = await menu.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          overflow: el.scrollWidth > el.clientWidth,
          count: el.querySelectorAll('.message-action-row').length,
          width: rect.width,
          reactions: el.querySelectorAll('.message-reaction-strip button[aria-pressed]').length,
          moreVisible:
            el.querySelector('.message-reaction-strip button:last-child').getBoundingClientRect()
              .width > 0,
        };
      });
      check(
        geometry.left >= 0 &&
          geometry.top >= 0 &&
          geometry.right <= width &&
          geometry.bottom <= height &&
          !geometry.overflow,
        `${theme}/${width}/${height}/${corner}: 菜单溢出 ${JSON.stringify(geometry)}`,
      );
      check(geometry.count === 3, '扩展按钮区必须固定三行');
      check(geometry.width <= 236, '菜单未缩窄');
      check(geometry.reactions === 4 && geometry.moreVisible, '应显示四个贴表情候选和更多入口');
      const layout = await menu.evaluate((el) => {
        const center = (node) => {
          const rect = node.getBoundingClientRect();
          return rect.left + rect.width / 2;
        };
        const main = [...el.querySelectorAll('.message-menu-main button')];
        const row = el.querySelector('[aria-label="消息互动"]');
        const cells = [...row.querySelectorAll('button')].filter(
          (button) => getComputedStyle(button).display !== 'none',
        );
        const icons = cells.map((button) => center(button.firstElementChild));
        return {
          topRows: main.map((button) => button.getBoundingClientRect().top),
          aligned: main.every(
            (button, index) =>
              Math.abs(center(button.firstElementChild) - icons[(index % 2) * 2]) < 1,
          ),
          centered: cells.every(
            (button) => Math.abs(center(button) - center(button.firstElementChild)) < 1,
          ),
          equal: cells.every(
            (button) =>
              Math.abs(
                button.getBoundingClientRect().width - cells[0].getBoundingClientRect().width,
              ) < 1,
          ),
        };
      });
      check(
        layout.topRows[0] === layout.topRows[1] &&
          layout.topRows[2] === layout.topRows[3] &&
          layout.topRows[2] > layout.topRows[0],
        '常用按钮未排成 2×2',
      );
      check(layout.aligned && layout.centered && layout.equal, '四列等宽居中或上下图标对齐失败');
      if (output && corner === 'top-left')
        await page.screenshot({ path: resolve(output, `${theme}-${width}-${height}.png`) });
      const before = await menu.boundingBox();
      await page.getByRole('menuitem', { name: '文件操作', exact: true }).click();
      const back = await page
        .getByRole('button', { name: '返回消息操作', exact: true })
        .boundingBox();
      check(
        back.y >= before.y && back.y + back.height <= before.y + before.height,
        '低高度窗口的返回按钮被滚动裁切',
      );
      // disabled 按钮仍应立即提供原因，不能依赖 250ms 全局延迟。
      const reveal = page.getByRole('button', { name: '在文件夹中显示', exact: true });
      await reveal.scrollIntoViewIfNeeded();
      await reveal.hover();
      await page.waitForFunction(() =>
        document.querySelector('[role="tooltip"]')?.textContent?.includes('暂不可用'),
      );
      await page.keyboard.press('Escape');
      check(
        await page
          .getByRole('menuitem', { name: '文件操作', exact: true })
          .evaluate((el) => document.activeElement === el),
        '子菜单返回未恢复焦点',
      );
      const after = await menu.boundingBox();
      check(JSON.stringify(before) === JSON.stringify(after), '子菜单改变了主菜单位置或尺寸');
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
    }
  }
  // 动作最多、最少、语音及混合内容均保持同一组十二格，不重叠、不因缺项前移。
  await page.setViewportSize({ width: 320, height: 640 });
  let slots;
  for (const mode of ['full', 'sparse', 'voice', 'mixed']) {
    await page.evaluate(
      (mode) => window.menuFixture(0, 0, true, 'dark', '#b7dfdd', 'dots', mode),
      mode,
    );
    await page.getByRole('menu').waitFor();
    await page.waitForFunction(
      (mode) =>
        document
          .querySelector('[data-menu-fixture-mode]')
          ?.getAttribute('data-menu-fixture-mode') === mode,
      mode,
    );
    const layout = await page.locator('.message-action-row').evaluateAll((rows) =>
      rows.map((row) => {
        const cells = [...row.querySelectorAll('button')].filter(
          (button) => getComputedStyle(button).display !== 'none',
        );
        return cells.map((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return { x, y, width, height, disabled: button.disabled };
        });
      }),
    );
    check(
      layout.length === 3 && layout.every((row) => row.length === 4),
      `${mode}: 非 3×4 ${JSON.stringify(layout)}`,
    );
    const positions = layout.map((row) => row.map(({ disabled, ...rect }) => rect));
    if (slots) check(JSON.stringify(positions) === JSON.stringify(slots), `${mode}: 格位移动`);
    else slots = positions;
    if (output) await page.screenshot({ path: resolve(output, `${mode}-main-320.png`) });
    for (const row of positions)
      for (let index = 1; index < row.length; index++)
        check(row[index].x >= row[index - 1].x + row[index - 1].width, `${mode}: 按钮重叠`);
    if (mode === 'sparse')
      check(layout.flat().filter((cell) => cell.disabled).length >= 11, '不可用动作未置灰');
    if (mode !== 'sparse') {
      await page.getByRole('menuitem', { name: '内容处理', exact: true }).click();
      await page.getByRole('button', { name: '添加到表情', exact: true }).waitFor();
      const voice = page
        .locator('[data-submenu-panel="content"] button:visible')
        .filter({ hasText: /^转换为文字$/ });
      check((await voice.isDisabled()) === (mode === 'full'), `${mode}: 语音转换状态错误`);
      if (mode === 'mixed') {
        check(
          await page.getByRole('menuitem', { name: '显示 Markdown', exact: true }).isDisabled(),
          '混合内容应保留置灰的 Markdown 格位',
        );
      }
      if (output) await page.screenshot({ path: resolve(output, `${mode}-content-320.png`) });
      if (mode === 'mixed') {
        await voice.click();
        check(await page.evaluate(() => window.menuActions.includes('转文字')), '语音转换未执行');
        await page.getByRole('menu').waitFor({ state: 'detached' });
      } else await page.getByRole('button', { name: '返回消息操作', exact: true }).click();
    }
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.menuFixture(50, 50, false, 'light', '#19764c', 'plain'));
  await page.getByRole('button', { name: '取消贴表情：赞', exact: true }).click();
  check(await page.evaluate(() => window.menuActions.includes('76:false')), '回应没有切换为取消');
  await page.getByRole('menuitem', { name: '+1', exact: true }).click();
  check(await page.evaluate(() => window.menuActions.includes('+1')), '+1 没有执行');
  await page.keyboard.press('End');
  await page.keyboard.press('Escape');
  check(
    await page.locator('#origin').evaluate((el) => document.activeElement === el),
    'Esc 未归还焦点',
  );
  await page.evaluate(() => window.menuFixture(50, 50, false, 'light', '#19764c', 'plain'));
  await page.getByRole('button', { name: '更多表情', exact: true }).click();
  const selected = page
    .getByRole('dialog', { name: '贴表情' })
    .getByRole('button', { name: '赞', exact: true });
  check((await selected.getAttribute('aria-pressed')) === 'true', '更多面板没有显示已贴状态');
  await selected.click();
  check(
    await page.evaluate(() => window.menuActions.includes('more:76:false')),
    '更多面板不能取消已贴回应',
  );
  // 在真实触屏 context 中验证长按只提示，松手不执行。
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const touchPage = await touch.newPage();
  await touchPage.goto(page.url());
  await touchPage.waitForFunction(() => window.menuFixture);
  await touchPage.evaluate(() => window.menuFixture(100, 100, true, 'light', '#19764c', 'plain'));
  const target = touchPage.getByRole('menuitem', { name: '本地删除', exact: true });
  const bounds = await target.boundingBox();
  const session = await touchPage.context().newCDPSession(touchPage);
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await touchPage.waitForFunction(
    () => document.querySelector('[role="tooltip"]')?.textContent === '本地删除',
  );
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check(
    await touchPage.evaluate(() => !window.menuActions.includes('本地删除')),
    '长按松手执行了删除',
  );
  await target.tap();
  check(await touchPage.evaluate(() => window.menuActions.includes('本地删除')), '长按后短按失效');
  await touch.close();
  check(errors.length === 0, errors.join('\n'));
  console.log(
    '消息菜单浏览器验证通过：5 组主题/尺寸、四角避让、固定 2×2 与 3×4、最多/最少/语音/混合内容格位一致且不重叠、子菜单原位返回、禁用提示、回应取消、+1、焦点归还及真实触屏长按。',
  );
} finally {
  await browser?.close();
  await server.close();
}
