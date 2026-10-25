import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'trpc.stub.ts') },
      {
        find: /^@weq\/agentlab$/,
        replacement: resolve(root, '../../packages/agentlab/src/model_selection.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [resolve(root, '../..')] } },
});
let browser;
const output = process.env.WEQ_TIMELINE_ARTIFACTS;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(`http://127.0.0.1:${port}/test/browser/timeline.html`);
  await page.waitForSelector('.weq-virtual-timeline-row');
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const mounted = () => page.locator('.weq-virtual-timeline-row').count();
  assert((await mounted()) < 80, 'DOM grows with all 3000 messages');
  await page.evaluate(() => window.timelineTest.jump('row-1500'));
  await page.waitForSelector('[data-message-id="row-1500"]');
  await page.waitForTimeout(250);
  const anchor = await page.evaluate(() => window.timelineTest.capture());
  assert(anchor.anchorId, 'Missing reading anchor');
  await page.evaluate(
    (id) => window.timelineTest.grow(`row-${Number(id.slice(4)) - 1}`),
    anchor.anchorId,
  );
  await page.waitForTimeout(250);
  const grown = await page.evaluate(() => window.timelineTest.capture());
  assert(
    grown.anchorId === anchor.anchorId && Math.abs(grown.offset - anchor.offset) < 3,
    `Height change above viewport moved reading anchor: ${JSON.stringify({ anchor, grown })}`,
  );
  await page.evaluate(() => window.timelineTest.prepend());
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => window.timelineTest.capture());
  assert(
    after.anchorId === anchor.anchorId,
    `Prepend moved anchor: ${anchor.anchorId} -> ${after.anchorId}`,
  );
  await page.evaluate((saved) => window.timelineTest.restore(saved), anchor);
  await page.waitForTimeout(150);
  const restored = await page.evaluate(() => window.timelineTest.capture());
  assert(
    restored.anchorId === anchor.anchorId && Math.abs(restored.offset - anchor.offset) < 3,
    'Reading restore moved pixels',
  );
  await page.evaluate(() => window.timelineTest.append());
  await page.waitForTimeout(100);
  assert(
    (await page.evaluate(() => window.timelineTest.capture())).anchorId === anchor.anchorId,
    'Append yanked history to tail',
  );
  await page.evaluate(() => {
    window.timelineTest.clearSelection();
    window.timelineTest.enterSelection();
    window.timelineTest.jump('row-1700');
  });
  await page.waitForTimeout(250);
  const box = await page.locator('.message-scroll').boundingBox();
  await page.mouse.move(box.x + 4, box.y + 45);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + box.height - 12, { steps: 4 });
  await page.evaluate(() => {
    const scroll = document.querySelector('.message-scroll');
    scroll.scrollTop += 6500;
    scroll.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(100);
  const dragged = await page.evaluate(() => window.timelineTest.selected());
  assert(dragged.length > 40, `Fast cross-window marquee lost unmounted rows: ${dragged.length}`);
  await page.evaluate(() => window.timelineTest.selectAll());
  await page.waitForTimeout(150);
  assert(
    (await page.evaluate(() => window.timelineTest.selected())).length === 3051,
    'Selection lost unmounted messages',
  );
  assert((await mounted()) < 80, 'Selecting all mounted every selected row');
  await page.evaluate(() => {
    window.timelineTest.clearSelection();
    window.timelineTest.setCount(100);
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => window.timelineTest.jump('row-1050'));
  await page.waitForTimeout(100);
  const shortAnchor = await page.evaluate(() => window.timelineTest.capture());
  await page.evaluate(() => window.timelineTest.setCount(3000));
  await page.waitForTimeout(250);
  const expandedAnchor = await page.evaluate(() => window.timelineTest.capture());
  assert(
    expandedAnchor.anchorId === shortAnchor.anchorId &&
      Math.abs(expandedAnchor.offset - shortAnchor.offset) < 3,
    `Crossing virtualization threshold moved reader: ${JSON.stringify({ shortAnchor, expandedAnchor })}`,
  );
  await page.evaluate(() => {
    window.timelineTest.clearSelection();
    const scroll = document.querySelector('.message-scroll'),
      bounds = scroll.getBoundingClientRect();
    [...scroll.querySelectorAll('[data-weq-select-id]')]
      .find((row) => row.getBoundingClientRect().top > bounds.top)
      ?.focus({ preventScroll: true });
  });
  await page.keyboard.press('End');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('data-message-id') === 'row-4000',
  );
  await page.keyboard.press('Shift+Home');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('data-message-id') === 'row-1001',
  );
  assert(
    (await page.evaluate(() => window.timelineTest.selected())).length === 3000,
    'Keyboard range lost unmounted messages',
  );
  await page.getByRole('button', { name: '导出所选消息', exact: true }).click();
  await page.waitForFunction(
    () => window.timelineTest.exportSelection()?.scope?.ids?.length === 3000,
  );
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.timelineCopied = text;
        },
      },
    }),
  );
  await page.evaluate(() =>
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (command) => {
        if (command !== 'copy') return false;
        window.timelineCopied = document.querySelector('textarea[aria-hidden="true"]')?.value;
        return true;
      },
    }),
  );
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByRole('menuitem', { name: '纯文本', exact: true }).click();
  await page.waitForFunction(
    () =>
      window.timelineCopied?.includes('合成消息 1001') &&
      window.timelineCopied?.includes('合成消息 4000'),
  );
  await page.evaluate(() => {
    window.timelineTest.clearSelection();
    window.timelineTest.jump('row-1200');
  });
  await page.waitForSelector('[data-message-id="row-1200"]');
  await page.evaluate(() => {
    window.timelineTest.pinPlayback('row-1200');
    window.timelineTest.jump('row-3500');
  });
  await page.waitForSelector('[data-message-id="row-3500"]');
  assert(
    (await page.locator('[data-message-id="row-1200"]').count()) === 1,
    'Scrolling unmounted active playback',
  );
  await page.evaluate(() => {
    window.timelineTest.unpinPlayback('row-1200');
    window.timelineTest.jump('row-3600');
  });
  await page.waitForSelector('[data-message-id="row-3600"]');
  await page.waitForTimeout(100);
  assert(
    (await page.locator('[data-message-id="row-1200"]').count()) === 0,
    'Completed playback kept an offscreen row',
  );
  await page.evaluate(() => window.timelineTest.latestWindow());
  await page.waitForTimeout(100);
  const beforeHide = await page.evaluate(() => window.timelineTest.capture());
  await page.evaluate(() => window.timelineTest.dropInitialPosition());
  for (let repeat = 0; repeat < 5; repeat++) {
    await page.evaluate(() => window.timelineTest.active(false));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.timelineTest.active(true));
    await page.waitForTimeout(100);
  }
  const afterHide = await page.evaluate(() => window.timelineTest.capture());
  assert(
    afterHide.anchorId === beforeHide.anchorId,
    `Hidden view lost reading anchor: ${JSON.stringify({ beforeHide, afterHide })}`,
  );
  await page.evaluate(() => {
    window.timelineTest.clearSelection();
    window.timelineTest.mixedRows();
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.timelineTest.jump('row-1080-tip'));
  await page.waitForSelector('[data-message-id="row-1080-tip"]');
  assert(
    await page
      .locator('[data-message-id="row-1080-tip"]')
      .textContent()
      .then((text) => text.includes('合成系统消息')),
    'Virtual gray tip missing',
  );
  assert(
    (await page.locator('[data-message-id="row-1080"]').count()) === 1,
    'Same-seq row was lost or duplicated',
  );
  const gapId = await page.locator('.weq-selectable-gap').first().getAttribute('data-message-id');
  assert(
    await page.evaluate((id) => window.timelineTest.jump(id), gapId),
    'Gap selection target not represented in virtual index',
  );
  if (output) await mkdir(output, { recursive: true });
  const screenshots = [];
  for (const [theme, width, height, background, accent] of [
    ['light', 1280, 900, 'plain', '#107a54'],
    ['dark', 1280, 900, 'grid', '#f0bd52'],
    ['light', 390, 844, 'paper', '#b83057'],
    ['dark', 390, 844, 'dots', '#75cabb'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(
      ({ theme, background, accent }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.background = background;
        document.documentElement.style.setProperty('--weq-accent-effective', accent);
      },
      { theme, background, accent },
    );
    await page.waitForTimeout(200);
    const bounds = await page.evaluate(() => {
      const scroll = document.querySelector('.message-scroll');
      const rect = scroll.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        rows: scroll.querySelectorAll('[data-message-id]').length,
        overflows: document.documentElement.scrollWidth > innerWidth + 1,
      };
    });
    assert(
      bounds.width > 100 && bounds.height > 100 && bounds.rows > 0 && !bounds.overflows,
      `Blank or overflowing ${theme}/${width}: ${JSON.stringify(bounds)}`,
    );
    if (output) {
      const path = resolve(output, `${theme}-${width}.png`);
      await page.screenshot({ path });
      screenshots.push(path);
    }
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  const report = {
    logicalMessages: 2997,
    mountedRows: await mounted(),
    anchor,
    restored,
    draggedRows: dragged.length,
    shortAnchor,
    expandedAnchor,
    keyboardSelected: 3000,
    exportedIds: 3000,
    copiedBoundaryMessages: true,
    playbackPinning: true,
    hideRestore: beforeHide.anchorId === afterHide.anchorId,
    gap: Boolean(gapId),
    screenshots,
    errors,
  };
  if (output)
    await writeFile(resolve(output, 'timeline-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await server.close();
}
