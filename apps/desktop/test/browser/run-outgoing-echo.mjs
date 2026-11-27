import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.cache/outgoing-echo'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/slash-emoji.stub.ts'),
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
const output = process.env.WEQ_ECHO_ARTIFACTS;
if (output) await mkdir(output, { recursive: true });
let cases = 0;
try {
  await server.listen();
  for (const [engine, type] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const executablePath =
      engine === 'webkit' ? process.env.WEQ_WEBKIT_EXECUTABLE : process.env.WEQ_BROWSER_EXECUTABLE;
    const browser = await type.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      for (const width of [320, 390, 1280])
        for (const theme of ['light', 'dark']) {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          try {
            await page.goto(
              `http://127.0.0.1:${server.httpServer.address().port}/test/browser/outgoing-echo.html`,
            );
            await page.evaluate((theme) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.style.setProperty(
                '--weq-accent-effective',
                theme === 'light' ? '#15764a' : '#ebbd51',
              );
            }, theme);
            await page.getByText('不等电脑和装扮，发送后立即显示。', { exact: true }).waitFor();
            assert.equal(await page.getByRole('status', { name: '正在传给电脑' }).count(), 2);
            const metrics = await page.locator('.weq-message-sending').evaluateAll((nodes) =>
              nodes.map((node) => {
                const rect = node.getBoundingClientRect();
                const icon = node.querySelector('.lucide-monitor');
                const monitor = icon.getBoundingClientRect();
                return {
                  left: rect.left,
                  right: rect.right,
                  width: rect.width,
                  height: rect.height,
                  dx: monitor.x + monitor.width / 2 - rect.x - rect.width / 2,
                  dy: monitor.y + monitor.height / 2 - rect.y - rect.height / 2,
                  animation: getComputedStyle(icon).animationName,
                  spin: getComputedStyle(node.querySelector('.weq-message-send-spinner'))
                    .animationName,
                };
              }),
            );
            for (const row of metrics) {
              assert.ok(row.left >= 0 && row.right <= width, JSON.stringify(row));
              assert.ok(Math.abs(row.dx) < 0.1 && Math.abs(row.dy) < 0.1, JSON.stringify(row));
              assert.equal(row.animation, 'none');
              assert.equal(row.spin, 'weq-message-send-spin');
            }
            if (output)
              await page.screenshot({ path: resolve(output, `${engine}-${theme}-${width}.png`) });
            await page.evaluate(() => window.echoQA.setStage('qq'));
            await page.getByRole('status', { name: '发送中', exact: true }).first().waitFor();
            assert.equal(await page.locator('.lucide-monitor').count(), 0);
            const settled = await page.locator('.weq-message-sending').evaluateAll((nodes) =>
              nodes.map((node) => ({
                width: node.getBoundingClientRect().width,
                height: node.getBoundingClientRect().height,
              })),
            );
            assert.deepEqual(
              settled,
              metrics.map(({ width, height }) => ({ width, height })),
            );
            if (width === 390 && theme === 'light') {
              const content = page.locator('.message-content').first();
              const node = await content.elementHandle();
              const before = await content.boundingBox();
              const name = page.locator('.message-name').first();
              assert.equal(await name.textContent(), '群头衔群昵称');
              const seq = page.getByText('seq 12', { exact: true });
              const nameMotion = await name.evaluate((element) => {
                const before = element.getBoundingClientRect().x;
                window.echoQA.setStage('acked');
                const animation = element.getAnimations()[0];
                if (!animation) return null;
                animation.pause();
                animation.currentTime = 0;
                const start = element.getBoundingClientRect().x;
                animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
                const middle = element.getBoundingClientRect().x;
                animation.finish();
                return { before, start, middle, end: element.getBoundingClientRect().x };
              });
              assert.ok(nameMotion, '群头衔和昵称应随序号一起过渡');
              assert.ok(
                Math.abs(nameMotion.start - nameMotion.before) < 1,
                JSON.stringify(nameMotion),
              );
              assert.ok(nameMotion.start > nameMotion.middle && nameMotion.middle > nameMotion.end);
              await seq.waitFor();
              await page.waitForFunction(() =>
                document
                  .querySelector('.weq-message-seq')
                  ?.getAnimations()
                  .some((a) => a.playState === 'running'),
              );
              assert.equal(await content.evaluate((element, old) => element === old, node), true);
              assert.deepEqual(await content.boundingBox(), before);
              await page.evaluate(() => window.echoQA.setStage('confirmed'));
              await page.waitForFunction(() =>
                [...document.querySelectorAll('time')].some(
                  (time) =>
                    time.textContent === '11:00:02' &&
                    time.getAnimations().some((a) => a.playState === 'running'),
                ),
              );
              assert.equal(await content.evaluate((element, old) => element === old, node), true);
              await page.emulateMedia({ reducedMotion: 'reduce' });
              await page.evaluate(() => window.echoQA.setStage('qq'));
              await page.getByRole('status', { name: '发送中', exact: true }).first().waitFor();
              await page.evaluate(() => window.echoQA.setStage('confirmed'));
              await page.getByText('11:00:02', { exact: true }).first().waitFor();
              assert.equal(await seq.evaluate((element) => element.getAnimations().length), 0);
              assert.equal(await name.evaluate((element) => element.getAnimations().length), 0);
              assert.ok(Math.abs((await name.boundingBox()).x - nameMotion.end) < 1);
              assert.equal(
                await page
                  .getByText('11:00:02', { exact: true })
                  .first()
                  .evaluate((element) => element.getAnimations().length),
                0,
              );
              await page.evaluate(() => window.echoQA.setStage('qq'));
              await page.getByRole('status', { name: '发送中', exact: true }).first().waitFor();
            }
            await page.emulateMedia({ reducedMotion: 'reduce' });
            assert.ok(
              await page
                .locator('.weq-message-send-spinner')
                .evaluateAll((nodes) =>
                  nodes.every((node) => getComputedStyle(node).animationName === 'none'),
                ),
            );
            await page.evaluate(() => window.echoQA.setStage('failed'));
            await page.getByText('发送失败', { exact: true }).first().waitFor();
            assert.equal(await page.locator('.weq-message-sending').count(), 0);
            assert.equal(
              await page.getByText('不等电脑和装扮，发送后立即显示。', { exact: true }).count(),
              1,
            );
            assert.ok(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            );
            if (width === 390 && theme === 'dark') {
              await page.evaluate(() => window.echoQA.setStage('recalled'));
              const marker = page.getByRole('button', { name: '重新编辑' });
              await marker.getByText('你撤回了这条消息', { exact: true }).waitFor();
              const before = await marker.boundingBox();
              const point = { x: before.x + 6, y: before.y + before.height / 2 };
              await page.mouse.move(point.x, point.y);
              await marker.getByText('重新编辑', { exact: true }).waitFor();
              const stable = await marker.evaluate(
                async (element, { point, before }) => {
                  for (let frame = 0; frame < 24; frame++) {
                    await new Promise(requestAnimationFrame);
                    const rect = element.getBoundingClientRect();
                    if (
                      !element.matches(':hover') ||
                      !element.contains(document.elementFromPoint(point.x, point.y)) ||
                      ['x', 'y', 'width', 'height'].some((key) => rect[key] !== before[key])
                    )
                      return false;
                  }
                  return true;
                },
                { point, before },
              );
              assert.ok(stable, `${engine} 撤回标签的左侧应一直可点击`);
              await page.mouse.click(point.x, point.y);
              await marker.waitFor({ state: 'detached' });
            }
            assert.deepEqual(errors, []);
            cases++;
          } finally {
            await page.close();
          }
        }
    } finally {
      await browser.close();
    }
  }
  console.log(`PASS ${cases} Chromium/WebKit outgoing echo theme/viewport cases`);
} finally {
  await server.close();
}
