import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const platform = process.env.WEQ_TEST_PLATFORM ?? 'win32';
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, `node_modules/.vite-startup-layout-${platform}`),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/qq-data-access-trpc.stub.ts'),
      },
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
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.addInitScript((platform) => {
    window.windowCloseRequests = 0;
    window.windowControlRequests = [];
    window.browserCloseRequests = 0;
    window.close = () => window.browserCloseRequests++;
    window.electron = {
      process: { platform },
      ipcRenderer: {
        send: (channel) => {
          window.windowControlRequests.push(channel);
          if (channel === 'window-close') window.windowCloseRequests++;
        },
      },
    };
    window.logDirOpened = 0;
    window.weq = {
      openLogDir: async () => {
        window.logDirOpened++;
        return true;
      },
      // 本机开启「仿 Windows 窗口按钮」时的快照：标题栏走自绘三键，不再为红绿灯留白。
      windowChrome: {
        getSnapshot: () => ({ controls: 'windows' }),
        onChange: () => () => {},
      },
    };
  }, platform);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/startup-layout.html`,
  );
  for (const [width, height] of [
    [440, 680],
    [440, 760],
    [1180, 800],
    [440, 480],
    [390, 760],
    [552, 852],
  ]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window.startupQa.theme.getState().setPreference(theme), theme);
      const close = page.locator('.weq-shell-close-btn');
      {
        const before = await page.evaluate(() => window.windowCloseRequests);
        await close.click();
        assert.equal(
          await page.evaluate(() => window.windowCloseRequests),
          before + 1,
          '关闭按钮必须走主进程窗口关闭入口',
        );
        assert.equal(
          await page.evaluate(() => window.browserCloseRequests),
          0,
          '不能依赖浏览器 window.close',
        );
      }
      for (const status of ['restricted', 'entering', 'authorization']) {
        await page.evaluate(
          (status) =>
            window.startupQa.restricted.setState({
              enteringSince: status === 'entering' ? Date.now() : null,
              requests:
                status === 'authorization'
                  ? [{ kind: 'password', token: 1, title: '管理员授权', message: '合成授权请求' }]
                  : [],
            }),
          status,
        );
        const indicator = page.locator('.weq-restricted-indicator');
        const dragOverlaps = await indicator.evaluate((button) => {
          const box = button.getBoundingClientRect();
          return [...document.querySelectorAll('*')]
            .filter(
              (element) =>
                getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'drag',
            )
            .filter((element) => {
              const drag = element.getBoundingClientRect();
              return (
                drag.left < box.right &&
                drag.right > box.left &&
                drag.top < box.bottom &&
                drag.bottom > box.top
              );
            })
            .map((element) => element.className);
        });
        assert.deepEqual(dragOverlaps, [], '原生窗口拖动区不能覆盖受限模式按钮');
        await indicator.click();
        assert.equal(await page.evaluate(() => window.startupQa.restricted.getState().open), true);
        await indicator.click();
        assert.equal(await page.evaluate(() => window.startupQa.restricted.getState().open), false);
      }
      await page.evaluate(() =>
        window.startupQa.restricted.setState({ enteringSince: null, requests: [] }),
      );
      const log = page.getByRole('button', { name: '打开日志目录', exact: true });
      await log.click();
      await page.evaluate(() => {
        const store = window.startupQa.toast;
        store.setState({ toasts: [], leaving: [] });
        store.getState().push({ title: '合成受限模式提醒', durationKind: 'long', ttl: 0 });
      });
      const metrics = await page.evaluate(() => {
        const rect = (selector) =>
          document.querySelector(selector).getBoundingClientRect().toJSON();
        const log = document.querySelector('.weq-shell-log-btn');
        const box = log.getBoundingClientRect();
        return {
          footer: rect('.weq-account-actions'),
          toast: rect('.weq-toast-host'),
          indicator: rect('.weq-restricted-indicator'),
          log: box.toJSON(),
          heading: rect('.weq-account-heading'),
          actions: rect('.weq-shell-actions'),
          brand: rect('.weq-account-brand'),
          head: rect('.weq-account-head'),
          headingDrag: getComputedStyle(
            document.querySelector('.weq-account-heading'),
          ).getPropertyValue('-webkit-app-region'),
          drag: getComputedStyle(log).getPropertyValue('-webkit-app-region'),
          hit: log.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          ),
          overflow: document.documentElement.scrollWidth > innerWidth,
          opened: window.logDirOpened,
        };
      });
      assert.equal(metrics.drag, 'no-drag', '日志按钮必须排除窗口拖动命中区');
      assert.equal(metrics.hit, true, '日志按钮不能被页面遮挡');
      assert(metrics.opened > 0, '日志按钮必须调用打开目录桥接');
      assert.equal(metrics.overflow, false, '页面不能横向溢出');
      assert(Math.abs(metrics.brand.left - metrics.head.left - 24) <= 1, 'WeQ 标识保持左对齐');
      assert(metrics.head.top <= 1, 'macOS 不保留额外灰色标题栏');
      assert.equal(metrics.headingDrag, 'drag', '标题和空白处必须能拖动窗口');
      assert(metrics.heading.width >= 100, '标题栏必须保留可用的拖动宽度');
      assert(metrics.heading.right <= metrics.actions.left, '工具栏不能覆盖拖动区');
      assert(
        Math.abs(
          metrics.heading.y + metrics.heading.height / 2 - metrics.log.y - metrics.log.height / 2,
        ) <= 1,
        '标题和工具按钮必须垂直居中',
      );
      assert(
        metrics.indicator.right <= metrics.log.left &&
          metrics.log.left - metrics.indicator.right <= 12,
        '受限状态紧邻右侧工具按钮',
      );
      assert(Math.abs(height - metrics.footer.bottom - 12) <= 1, '账号管理操作栏靠底对齐');
      assert(
        metrics.toast.bottom <= metrics.footer.top - 4,
        '桌面窄窗口通知不能压在账号管理操作栏上',
      );
      if (process.env.WEQ_STARTUP_ARTIFACTS) {
        await mkdir(process.env.WEQ_STARTUP_ARTIFACTS, { recursive: true });
        await page.screenshot({
          path: resolve(
            process.env.WEQ_STARTUP_ARTIFACTS,
            `${platform}-${width}-${height}-${theme}.png`,
          ),
        });
      }
      await page.evaluate(() => {
        window.startupQa.restricted.setState({ reasons: [] });
        window.startupQa.toast.setState({ toasts: [], leaving: [] });
      });
      await page.locator('.weq-restricted-indicator').waitFor({ state: 'detached' });
      const footer = await page.locator('.weq-account-actions').boundingBox();
      assert(Math.abs(height - footer.y - footer.height - 12) <= 1, '完整模式操作栏同样靠底');
      if (process.env.WEQ_STARTUP_ARTIFACTS) {
        await page.screenshot({
          path: resolve(
            process.env.WEQ_STARTUP_ARTIFACTS,
            `${platform}-${width}-${height}-${theme}-full.png`,
          ),
        });
      }
      await page.evaluate(() =>
        window.startupQa.restricted.setState({
          reasons: [{ code: 'offline', title: 'QQ 不在线', guidance: '登录 QQ' }],
        }),
      );
    }
  }
  await page.evaluate(() => {
    const list = document.querySelector('.weq-account-list');
    const item = list.firstElementChild;
    for (let i = 0; i < 20; i++) list.append(item.cloneNode(true));
  });
  assert(
    await page
      .locator('.weq-account-list')
      .evaluate((list) => list.scrollHeight > list.clientHeight),
    '账号较多时列表滚动',
  );
  const footer = await page.locator('.weq-account-actions').boundingBox();
  assert(
    Math.abs(page.viewportSize().height - footer.y - footer.height - 12) <= 1,
    '长列表不能挤掉底部操作栏',
  );
  await page.evaluate(() => {
    window.startupQa.toast
      .getState()
      .push({ title: '合成 Web 通知', durationKind: 'long', ttl: 0 });
  });
  await page.locator('.weq-toast-host').evaluate((host) => host.classList.add('is-web'));
  assert.equal(
    await page.locator('.weq-toast-host').evaluate((host) => getComputedStyle(host).bottom),
    '76px',
    'Web 手机端仍保留底栏避让',
  );
  for (const surface of ['main', 'loading']) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/startup-layout.html?surface=${surface}`,
    );
    if (surface === 'main') {
      assert.equal(
        await page.locator('.app-title-bar-actions button').count(),
        3,
        'macOS 与 Windows/Linux 使用同款窗口按钮',
      );
      for (const title of ['最小化', '最大化/还原', '关闭']) {
        await page.locator('.app-title-bar-actions').getByTitle(title, { exact: true }).click();
      }
      assert.deepEqual(await page.evaluate(() => window.windowControlRequests), [
        'window-minimize',
        'window-maximize',
        'window-close',
      ]);
      assert.equal(
        await page.locator('.app-title-bar').evaluate((bar) => getComputedStyle(bar).paddingLeft),
        '0px',
        '主标题栏不再为红绿灯预留左侧空间',
      );
    }
    for (const width of [800, 1180]) {
      await page.setViewportSize({ width, height: 800 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          (theme) => window.startupQa.theme.getState().setPreference(theme),
          theme,
        );
        for (const status of ['restricted', 'entering', 'authorization']) {
          await page.evaluate(
            (status) =>
              window.startupQa.restricted.setState({
                enteringSince: status === 'entering' ? Date.now() : null,
                requests:
                  status === 'authorization'
                    ? [{ kind: 'password', token: 1, title: '管理员授权', message: '合成授权请求' }]
                    : [],
              }),
            status,
          );
          await page.locator('.weq-restricted-indicator').click();
          assert.equal(
            await page.evaluate(() => window.startupQa.restricted.getState().open),
            true,
          );
          await page.locator('.weq-restricted-indicator').click();
          assert.equal(
            await page.evaluate(() => window.startupQa.restricted.getState().open),
            false,
          );
          const layout = await page.evaluate((surface) => {
            const drag = document.querySelector(
              surface === 'main' ? '.app-title-bar-drag' : '.weq-startup-drag',
            );
            const box = drag.getBoundingClientRect();
            const buttons = [
              ...document.querySelectorAll(
                surface === 'main' ? '.app-title-bar button' : '.weq-startup-titlebar button',
              ),
            ];
            return {
              drag: getComputedStyle(drag).getPropertyValue('-webkit-app-region'),
              width: box.width,
              buttons: buttons.map((button) => {
                const rect = button.getBoundingClientRect();
                return {
                  label: button.title || button.getAttribute('aria-label'),
                  noDrag: getComputedStyle(button).getPropertyValue('-webkit-app-region'),
                  overlap:
                    box.left < rect.right &&
                    box.right > rect.left &&
                    box.top < rect.bottom &&
                    box.bottom > rect.top,
                  center: rect.top + rect.height / 2,
                  headerCenter: box.top + box.height / 2,
                };
              }),
            };
          }, surface);
          assert.equal(layout.drag, 'drag');
          assert(layout.width >= 24, '窗口标题栏保留独立拖动区');
          for (const button of layout.buttons) {
            assert.equal(button.overlap, false, '窗口按钮和受限菜单不能被拖动区覆盖');
            assert(
              Math.abs(button.center - button.headerCenter) <= 1,
              `${surface} ${button.label} 垂直居中：${button.center} / ${button.headerCenter}`,
            );
          }
        }
        if (process.env.WEQ_STARTUP_ARTIFACTS) {
          await page.screenshot({
            path: resolve(
              process.env.WEQ_STARTUP_ARTIFACTS,
              `${platform}-${surface}-${width}-${theme}.png`,
            ),
          });
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    `通过 ${platform} 账号页、启动页与主标题栏的深浅主题检查：关闭 IPC、按钮居中、拖动区隔离、三种受限状态点击、底部操作栏及横幅。`,
  );
} finally {
  await browser?.close();
  await server.close();
}
