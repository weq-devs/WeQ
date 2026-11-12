import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-qzone-native-controls'),
  plugins: [react()],
  resolve: {
    alias: [{ find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') }],
  },
  optimizeDeps: { entries: ['test/browser/qzone-native-controls.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});

async function playButton(session) {
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const controls = [];
  function visit(node) {
    if (node.attributes?.includes('-webkit-media-controls-play-button')) controls.push(node);
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
  throw new Error('未找到可见的原生播放按钮');
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
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
      const quad = await playButton(session);
      await page.mouse.click((quad[0] + quad[2]) / 2, (quad[1] + quad[5]) / 2);
      assert.equal(await page.locator('video').evaluate((video) => video.paused), paused);
      assert.equal(
        await page.locator('.weq-qz-preview').evaluate((root) => root === document.activeElement),
        true,
      );
    }
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
      escape: true,
      keyboardFocus: true,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
