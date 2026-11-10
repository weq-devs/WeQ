import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const engine = process.env.WEQ_STARTUP_BROWSER === 'webkit' ? engines.webkit : engines.chromium;
const source = resolve(root, 'src/renderer/src/lib/remoteStartupSurface.ts');
const { code } = await transformWithOxc(await readFile(source, 'utf8'), source);
const browser = await engine.launch({
  headless: true,
  ...(process.env.WEQ_BROWSER_EXECUTABLE
    ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const output = process.env.WEQ_REMOTE_STARTUP_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['light', 'dark']) {
      await page.setContent(
        `<style>body{font:16px system-ui;margin:0;padding:24px;color:${theme === 'dark' ? '#eee' : '#222'};background:${theme === 'dark' ? '#181818' : '#fff'}}h1{font-size:24px}button{font:inherit}</style><div id="root"><div data-weq-startup-pending>正在加载…</div></div>`,
      );
      await page.addScriptTag({
        type: 'module',
        content: `${code}\nwindow.observeRemoteStartupSurface=observeRemoteStartupSurface;`,
      });
      await page.waitForFunction(() => Boolean(window.observeRemoteStartupSurface));
      await page.evaluate(() => {
        window.ready = 0;
        window.stopStartup = window.observeRemoteStartupSurface(
          document.getElementById('root'),
          '.app-shell-root',
          () => {
            window.ready++;
          },
        );
      });
      const paint = () =>
        page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
      await paint();
      if (await page.evaluate(() => window.ready)) throw Error('整页加载时提前放行');
      await page.evaluate(() => {
        document.getElementById('root').innerHTML =
          '<main class="app-shell-root"><h1>合成 WeQ 界面</h1><button>设置</button><section role="status">会话列表加载中</section><div data-weq-startup-pending>正在加载页面模块…</div></main>';
      });
      await paint();
      if (await page.evaluate(() => window.ready)) throw Error('页面模块尚未结束时提前放行');
      await page.evaluate(() => document.querySelector('[data-weq-startup-pending]').remove());
      await page.waitForFunction(() => window.ready === 1);
      if (!(await page.getByRole('button', { name: '设置' }).isVisible()))
        throw Error('就绪时真实界面不可见');
      if (!(await page.getByRole('status').isVisible())) throw Error('业务列表加载被错误纳入等待');
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      await page.evaluate(() => {
        const change = document.createElement('span');
        document.querySelector('main').append(change);
      });
      await paint();
      if ((await page.evaluate(() => window.ready)) !== 1) throw Error('就绪后未停止观察');
      await page.evaluate(() => window.stopStartup());
      const duringUpdates = await page.evaluate(async () => {
        window.ready = 0;
        window.stopStartup = window.observeRemoteStartupSurface(
          document.getElementById('root'),
          '.app-shell-root',
          () => window.ready++,
        );
        let tick = 0;
        return await new Promise((resolve) => {
          const update = () => {
            document.querySelector('[role="status"]').setAttribute('data-tick', String(++tick));
            if (tick < 10) requestAnimationFrame(update);
            else resolve(window.ready);
          };
          requestAnimationFrame(update);
        });
      });
      if (duringUpdates !== 1) throw Error('无关 DOM 持续更新时就绪检测被反复重置');
      await page.evaluate(() => window.stopStartup());
      cases++;
    }
  }
  if (errors.length) throw Error(errors.join('\n'));
  console.log(
    JSON.stringify({
      cases,
      delayedSurface: true,
      businessDataExcluded: true,
      continuousUpdatesDoNotBlock: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
