import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { build, createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { _electron: electron } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const { default: electronExecutable } = await import('electron');
const output = process.env.WEQ_GROUP_SIDEBAR_ARTIFACTS ?? '/tmp/weq-qa/shots/group-sidebar';
const cache = resolve(root, 'node_modules/.vite-group-sidebar-electron');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(cache, 'renderer'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-sidebar.stub.ts'),
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
let application;
const report = { errors: [], windows: [], shots: [] };
try {
  await mkdir(output, { recursive: true });
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      ssr: resolve(root, 'test/browser/group-sidebar-electron-main.ts'),
      outDir: cache,
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        external: ['electron'],
        output: { entryFileNames: 'main.cjs', format: 'cjs' },
      },
    },
  });
  await server.listen();
  const port = server.httpServer.address().port;
  const env = {
    ...process.env,
    WEQ_GROUP_SIDEBAR_URL: `http://127.0.0.1:${port}/test/browser/group-sidebar.html`,
    WEQ_GROUP_SIDEBAR_USER_DATA: resolve(cache, 'user-data'),
    WEQ_GROUP_SIDEBAR_RESOURCES: resolve(root, '../../resources'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: electronExecutable,
    args: [resolve(cache, 'main.cjs')],
    env,
    timeout: 30_000,
  });
  application.context().setDefaultTimeout(20_000);
  const page = await application.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await application
    .context()
    .route('**/*', (route) =>
      route.request().url().startsWith('data:') ||
      route.request().url().startsWith('weq-asset:') ||
      new URL(route.request().url()).hostname === '127.0.0.1'
        ? route.continue()
        : route.abort(),
    );
  await page.getByRole('button', { name: '相册', exact: true }).waitFor();
  const open = async (label, selector) => {
    const [window] = await Promise.all([
      application.waitForEvent('window'),
      page.getByRole('button', { name: label, exact: true }).click(),
    ]);
    window.on('pageerror', (error) => report.errors.push(error.message));
    await window.locator(selector).waitFor();
    return window;
  };
  const albums = await open('相册', '.group-album-dialog');
  await albums.waitForFunction(() => document.title.includes('原来的群名称'));
  await page.getByRole('button', { name: '相册', exact: true }).click();
  assert.equal(application.windows().length, 2, '原生窗口未复用');
  await page.evaluate(() => window.groupSidebarQa.setGroup('54321'));
  await page.locator('.qa-chat-header').filter({ hasText: '另一个群' }).waitFor();
  const another = await open('相册', '.group-album-dialog');
  const files = await open('文件', '.group-file-dialog');
  await files.bringToFront();
  await files.waitForFunction(() => {
    const images = [...document.querySelectorAll('.weq-file-manager-name img')];
    return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
  });
  await files.locator('.weq-file-manager-status').click({ button: 'right' });
  await files.getByRole('menu', { name: '群文件操作', exact: true }).waitFor();
  assert.equal(await page.getByRole('menu', { name: '群文件操作', exact: true }).count(), 0);
  await files.keyboard.press('Escape');
  await files.getByRole('menu', { name: '群文件操作', exact: true }).waitFor({ state: 'hidden' });
  assert.ok((await albums.title()).includes('原来的群名称'), '切群改变已打开原生窗口');
  report.windows = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      title: window.getTitle(),
      minimum: window.getMinimumSize(),
      resizable: window.isResizable(),
      minimizable: window.isMinimizable(),
      preload: window.webContents.getLastWebPreferences().preload ?? null,
      nodeIntegration: window.webContents.getLastWebPreferences().nodeIntegration,
      sandbox: window.webContents.getLastWebPreferences().sandbox,
    })),
  );
  const resources = report.windows.filter(
    (window) => window.title.includes('群相册') || window.title.includes('群文件'),
  );
  assert.equal(resources.length, 3, '跨群资源窗没有并存');
  for (const window of resources) {
    assert.deepEqual(window.minimum, [640, 480]);
    assert.equal(window.resizable, true);
    assert.equal(window.minimizable, true);
    assert.equal(window.preload, null);
    assert.equal(window.nodeIntegration, false);
    assert.equal(window.sandbox, true);
  }
  await page.evaluate(() => window.groupSidebarQa.theme.getState().setPreference('dark'));
  await files.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  const screenshot = resolve(output, 'files-electron-window-dark.png');
  await files.screenshot({ path: screenshot });
  report.shots.push(screenshot);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle().includes('群文件'))
      ?.setSize(640, 480);
  });
  await files.waitForFunction(() => innerWidth <= 640);
  assert.equal(
    await files.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  const minimumShot = resolve(output, 'files-electron-window-minimum.png');
  await files.screenshot({ path: minimumShot });
  report.shots.push(minimumShot);
  const closing = [albums, another, files].map((window) => window.waitForEvent('close'));
  await page.evaluate(() => window.groupSidebarQa.setOwner('99999:another-source'));
  await Promise.all(closing);
  assert.equal(application.windows().length, 1, '切换数据源后原生窗口未释放');
  assert.deepEqual(report.errors, []);
  await writeFile(resolve(output, 'electron-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await application?.close();
  await server.close();
}
