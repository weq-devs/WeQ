import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = process.cwd();
const cache = resolve(root, 'node_modules/.cache/link-shot-qa');
const { _electron } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const { default: executablePath } = await import('electron');
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: resolve(root, 'test/browser/link-shot-electron.ts'),
    outDir: cache,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      external: ['electron'],
      output: { entryFileNames: 'main.cjs', format: 'cjs' },
    },
  },
});
const env = { ...process.env, WEQ_LINK_SHOT_USER_DATA: resolve(cache, 'user-data') };
delete env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({
  executablePath,
  args: [resolve(cache, 'main.cjs')],
  env,
});
try {
  const result = await application.evaluate(async () => globalThis.linkShotQA());
  assert.equal(result.png, true);
  assert.equal(result.painted, true, '真实截图未绘制由受控脚本更新的颜色');
  assert.ok(result.requests.includes('http://synthetic.invalid/paint.js'));
  assert.ok(!result.requests.includes('http://synthetic.invalid/page'), '主文档发生重复联网');
  assert.ok(
    !result.requests.some(
      (url) => url.includes('/frame') || url.startsWith('file:') || url.startsWith('ws:'),
    ),
  );
  assert.equal(result.windows, 0);
  const cancelled = await application.evaluate(async () => globalThis.linkShotQA(true));
  assert.equal(cancelled.png, false);
  assert.equal(cancelled.windows, 0);
  console.log(
    JSON.stringify({
      passed: true,
      guardedDynamicPaint: true,
      noMainRefetch: true,
      cancelled: true,
    }),
  );
} finally {
  await application.close();
}
