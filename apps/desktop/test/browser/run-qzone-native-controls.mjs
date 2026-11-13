import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-qzone-native-controls'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/media-preview.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/qzone-native-controls.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});

async function nativeControl(session, name = '-webkit-media-controls-play-button') {
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const controls = [];
  function visit(node) {
    if (node.attributes?.includes(name)) controls.push(node);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child);
  }
  visit(root);
  for (const node of controls) {
    try {
      const { model } = await session.send('DOM.getBoxModel', { nodeId: node.nodeId });
      if (model.width && model.height) return model.content;
    } catch {
      /* 隐藏的溢出菜单也包含一个播放按钮。 */
    }
  }
  throw new Error(`未找到可见的原生控件：${name}`);
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qzone-native-controls.html`,
  );
  const session = await page.context().newCDPSession(page);
  for (const kind of ['实况', '视频']) {
    await page.getByRole('button', { name: `打开${kind}`, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
    await page.locator('video').evaluate((video) => {
      video.pause();
      video.currentTime = 0;
      video.playbackRate = 0.1;
    });
    // 必须点击 UA shadow DOM 内的真实按钮；video.focus() 不能复现原生事件吞掉 Esc。
    for (const paused of [false, true, false]) {
      const quad = await nativeControl(session);
      await page.mouse.click((quad[0] + quad[2]) / 2, (quad[1] + quad[5]) / 2);
      assert.equal(await page.locator('video').evaluate((video) => video.paused), paused);
      assert.equal(
        await page
          .locator('.weq-unified-preview')
          .evaluate((root) => root === document.activeElement),
        true,
      );
    }
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('video')?.style.transform.includes('scale(1.25)'),
    );
    // 变换动画结束后用真实 UA 控件点击，不能用设置 DOM 属性替代用户操作。
    await page.locator('video').evaluate(async (video) => {
      await Promise.all(video.getAnimations().map((animation) => animation.finished));
      video.pause();
    });
    const zoomedPlay = await nativeControl(session);
    await page.mouse.click(
      (zoomedPlay[0] + zoomedPlay[2]) / 2,
      (zoomedPlay[1] + zoomedPlay[5]) / 2,
    );
    assert.equal(await page.locator('video').evaluate((video) => video.paused), false);
    const muted = await page.locator('video').evaluate((video) => video.muted);
    const mute = await nativeControl(session, '-webkit-media-controls-mute-button');
    await page.mouse.click((mute[0] + mute[2]) / 2, (mute[1] + mute[5]) / 2);
    assert.equal(await page.locator('video').evaluate((video) => video.muted), !muted);
    const timeline = await nativeControl(session, '-webkit-media-controls-timeline');
    const timelineY = (timeline[1] + timeline[5]) / 2;
    await page.mouse.move(timeline[0] + (timeline[2] - timeline[0]) * 0.2, timelineY);
    await page.mouse.down();
    await page.mouse.move(timeline[0] + (timeline[2] - timeline[0]) * 0.7, timelineY, { steps: 6 });
    await page.mouse.up();
    assert.ok(await page.locator('video').evaluate((video) => video.currentTime > 0.2));
    assert.match(
      await page.locator('video').getAttribute('style'),
      /translate3d\(0px, 0px, 0(?:px)?\)/,
    );
    if (process.env.WEQ_MEDIA_PREVIEW_ARTIFACTS)
      await page.screenshot({
        path: resolve(
          process.env.WEQ_MEDIA_PREVIEW_ARTIFACTS,
          `native-${kind === '实况' ? 'live' : 'video'}-zoom.png`,
        ),
      });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('button', { name: `打开${kind}`, exact: true }).click();
    await page.getByRole('button', { name: '关闭预览', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(
      await page
        .locator('video')
        .evaluate((video) => video === document.activeElement && video.matches(':focus-visible')),
      true,
    );
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      scenes: 2,
      nativePlayPause: true,
      zoomedNativeControls: true,
      seekAndMute: true,
      escape: true,
      keyboardFocus: true,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
