import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
await mkdir(resolve(root, 'node_modules/.cache'), { recursive: true });
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/timeline-scroll-'));
const baseline = process.env.WEQ_TIMELINE_BASELINE_REF;
const width = Number(process.env.WEQ_SCROLL_WIDTH ?? 1280);
const cachedBubbles = process.env.WEQ_SCROLL_CACHED_BUBBLES === '1';
const grouped = process.env.WEQ_SCROLL_GROUPED === '1';
const imageGrid = process.env.WEQ_SCROLL_IMAGE_GRID === '1';
const fixtureFlags = [
  cachedBubbles && '&cached-bubbles=1',
  grouped && '&grouped=1',
  imageGrid && '&image-grid=1',
]
  .filter(Boolean)
  .join('');
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: { entries: ['test/browser/timeline.html'] },
  plugins: [
    ...(baseline
      ? [
          {
            name: 'timeline-baseline',
            enforce: 'pre',
            load(id) {
              if (id === resolve(root, 'src/renderer/src/hooks/useVirtualTimeline.ts'))
                return execFileSync(
                  'git',
                  ['show', `${baseline}:apps/desktop/src/renderer/src/hooks/useVirtualTimeline.ts`],
                  { cwd: root, encoding: 'utf8' },
                );
            },
          },
        ]
      : []),
    react(),
    tailwind(),
  ],
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
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?count=25${fixtureFlags}`,
  );
  await page.waitForSelector('[data-message-id="row-1001"]');
  if (imageGrid) {
    const grid = page.locator('[data-message-id="row-1004"] .qq-image-grid');
    await grid.waitFor();
    const layout = await grid.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll('.qq-image-grid-tile > span button.qq-media-wrap')].map(
        (button) => {
          const rect = button.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            square: Math.abs(rect.width - rect.height) < 1,
            within: rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1,
          };
        },
      );
    });
    assert.equal(layout.length, 4);
    assert.ok(
      layout.every((tile) => tile.square && tile.within),
      JSON.stringify(layout),
    );
    assert.equal(layout[0].y, layout[2].y);
    assert.ok(layout[0].x < layout[1].x && layout[1].x < layout[2].x);
    assert.equal(layout[3].x, layout[0].x);
    assert.ok(layout[3].y > layout[0].y);
  }
  if (grouped && !cachedBubbles) {
    const layout = await page.evaluate(() => {
      const first = document.querySelector('[data-message-id="row-1003"]');
      const last = document.querySelector('[data-message-id="row-1004"]');
      const upper = first.querySelector('.message-content');
      const lower = last.querySelector('.message-content');
      return {
        firstAvatar: Boolean(first.querySelector('.avatar')),
        lastAvatar: Boolean(last.querySelector('.avatar')),
        leftOffset: Math.abs(
          upper.getBoundingClientRect().left - lower.getBoundingClientRect().left,
        ),
        gap: last.getBoundingClientRect().top - first.getBoundingClientRect().bottom,
        joins: [
          getComputedStyle(upper).borderEndStartRadius,
          getComputedStyle(lower).borderStartStartRadius,
        ],
      };
    });
    assert.ok(layout.firstAvatar && !layout.lastAvatar);
    assert.ok(layout.leftOffset < 1 && layout.gap >= 3 && layout.gap <= 5, JSON.stringify(layout));
    assert.deepEqual(layout.joins, ['3px', '3px']);
  }
  await page.evaluate(() => {
    window.scrollProbe = { active: false, phase: '', samples: [] };
    const sample = () => {
      const state = window.scrollProbe,
        scroll = document.querySelector('.message-scroll');
      if (state.active && scroll && state.samples.length < 2000) {
        const bounds = scroll.getBoundingClientRect();
        const rows = [...scroll.querySelectorAll('.weq-virtual-timeline-row')];
        const visible = rows
          .map((row) => row.getBoundingClientRect())
          .filter((rect) => rect.bottom > bounds.top && rect.top < bounds.bottom);
        const top = Math.min(...visible.map((rect) => rect.top));
        const bottom = Math.max(...visible.map((rect) => rect.bottom));
        const anchor = state.anchorId
          ? rows
              .find((row) => row.querySelector(`[data-message-id="${state.anchorId}"]`))
              ?.querySelector(`[data-message-id="${state.anchorId}"]`)
          : null;
        state.samples.push({
          frameAt: performance.now(),
          decoratedRows: scroll.querySelectorAll('.message-line[data-bubble="21009"]').length,
          bubbleFallbacks: scroll.querySelectorAll(
            '.message-line[data-message-id]:not([data-bubble="21009"])',
          ).length,
          phase: state.phase,
          offset: scroll.scrollTop,
          mounted: rows.length,
          visible: visible.length,
          blankTop: Math.max(0, top - bounds.top),
          blankBottom: Math.max(0, bounds.bottom - bottom),
          blank: !visible.length || top - bounds.top > 48 || bounds.bottom - bottom > 48,
          anchorTop: anchor ? anchor.getBoundingClientRect().top - bounds.top : null,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const frames = (count) =>
    page.evaluate(
      (count) =>
        new Promise((resolve) => {
          const next = () => (--count > 0 ? requestAnimationFrame(next) : resolve());
          requestAnimationFrame(next);
        }),
      count,
    );
  const beforePrepend = await page.evaluate(() => {
    window.scrollProbe.active = true;
    window.scrollProbe.phase = 'prepend-cross-threshold';
    const position = window.timelineTest.capture();
    window.scrollProbe.anchorId = position.anchorId;
    window.timelineTest.prepend();
    return position;
  });
  await frames(8);
  await page.evaluate(() => {
    window.scrollProbe.active = false;
    window.scrollProbe.anchorId = null;
    window.timelineTest.setCount(3000);
  });
  await frames(4);
  await page.evaluate(() => window.timelineTest.jump('row-2000'));
  await page.waitForSelector('[data-message-id="row-2000"]');
  await frames(3);
  await page.mouse.move(width / 2, 450);
  await page.evaluate(() => {
    window.scrollProbe.phase = 'fast-wheel';
    window.scrollProbe.active = true;
  });
  for (const delta of [1200, 1800, 2400, 1800, -2400, -1800, -2400, 2400, -1800, 1200]) {
    await page.mouse.wheel(0, delta);
    await frames(2);
  }
  await frames(4);
  const samples = await page.evaluate(() => {
    window.scrollProbe.active = false;
    return window.scrollProbe.samples;
  });
  if (!baseline) {
    for (const { phase, anchorTop } of samples) {
      if (phase !== 'prepend-cross-threshold') continue;
      assert.ok(
        anchorTop !== null && Math.abs(anchorTop - beforePrepend.offset) <= 2,
        `跨虚拟化阈值翻页后阅读位置变化 ${JSON.stringify({ anchorTop, beforePrepend })}`,
      );
    }
  }
  const report = {
    width,
    cachedBubbles,
    grouped,
    imageGrid,
    baseline: baseline ?? null,
    samples: samples.length,
    blankFrames: samples.filter((sample) => sample.blank),
    maxMounted: Math.max(...samples.map((sample) => sample.mounted)),
    bubbleFallbackFrames: cachedBubbles
      ? samples.filter((sample) => sample.bubbleFallbacks > 0)
      : [],
    minDecoratedRows: cachedBubbles
      ? Math.min(...samples.map((sample) => sample.decoratedRows))
      : 0,
    frameGapsMs: samples
      .slice(1)
      .flatMap((sample, index) =>
        sample.phase === samples[index].phase
          ? [Math.round((sample.frameAt - samples[index].frameAt) * 10) / 10]
          : [],
      ),
    offsets: [...new Set(samples.map((sample) => Math.round(sample.offset)))],
  };
  if (process.env.WEQ_SCROLL_REPORT)
    await writeFile(
      process.env.WEQ_SCROLL_REPORT,
      JSON.stringify({ ...report, frames: samples }, null, 2),
    );
  console.log(JSON.stringify(report));
  if (report.blankFrames.length) throw new Error('快速滚动出现未覆盖视口');
  if (report.bubbleFallbackFrames.length) throw new Error('快速滚动出现默认气泡');
  if (cachedBubbles && report.minDecoratedRows < 1) throw new Error('缺少实际气泡行');
  if (report.maxMounted >= 150) throw new Error('预挂载恢复为大规模全量挂载');
  if (!baseline && width >= 1000 && !cachedBubbles) {
    let finishImage;
    const pendingImage = new Promise((resolve) => {
      finishImage = resolve;
    });
    await page.route('**/timeline-delayed.svg', async (route) => {
      await pendingImage;
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="teal"/></svg>',
      });
    });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?count=180&delay-media${fixtureFlags}`,
    );
    await page.waitForFunction(() => window.timelineTest?.jump);
    const imageRequest = page.waitForRequest('**/timeline-delayed.svg');
    await page.evaluate(() => window.timelineTest.jump('row-1102'));
    await imageRequest;
    const media = page.locator('[data-message-id="row-1102"] img.qq-media-image');
    const next = page.locator('[data-message-id="row-1103"]');
    await next.waitFor();
    await frames(4);
    const before = { image: await media.boundingBox(), next: await next.boundingBox() };
    finishImage();
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-message-id="row-1102"] img.qq-media-image');
      return image?.naturalHeight === 600 && Number(getComputedStyle(image).opacity) > 0;
    });
    await frames(4);
    const after = { image: await media.boundingBox(), next: await next.boundingBox() };
    if (
      Math.abs(before.image.height - after.image.height) > 1 ||
      Math.abs(before.next.y - after.next.y) > 1
    )
      throw new Error(`未知尺寸的图片改变了消息位置 ${JSON.stringify({ before, after })}`);

    await page.evaluate(() => {
      const scroll = document.querySelector('.message-scroll');
      const row = document.querySelector('[data-message-id="row-1103"]').parentElement;
      scroll.scrollTop +=
        row.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top + 72;
    });
    await frames(4);
    const drift = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const scroll = document.querySelector('.message-scroll');
          const row = document.querySelector('[data-message-id="row-1103"]');
          const next = document.querySelector('[data-message-id="row-1104"]');
          scroll.addEventListener(
            'scroll',
            () => {
              const top = next.getBoundingClientRect().top;
              const observer = new ResizeObserver(() => {
                observer.disconnect();
                resolve(next.getBoundingClientRect().top - top);
              });
              observer.observe(row.parentElement);
              row.style.minHeight = `${row.getBoundingClientRect().height + 40}px`;
            },
            { once: true },
          );
          scroll.scrollTop -= 10;
        }),
    );
    if (Math.abs(drift) > 1) throw new Error(`向上滚动时行高变化移动了锚点 ${drift}px`);
    const waitForScrollIdle = () =>
      page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const scroll = document.querySelector('.message-scroll');
            let timer;
            const finish = (error) => {
              clearTimeout(timer);
              clearTimeout(deadline);
              scroll.removeEventListener('scroll', schedule);
              if (error) reject(error);
              else resolve();
            };
            const schedule = () => {
              clearTimeout(timer);
              timer = setTimeout(finish, 200);
            };
            const deadline = setTimeout(() => finish(new Error('滚动未停止')), 3000);
            // 等最后一次滚动事件交付后再验停滚缓动，包含行高补偿触发的滚动。
            scroll.addEventListener('scroll', schedule);
            schedule();
          }),
      );
    for (const [reducedMotion, interrupt] of [
      ['no-preference', false],
      ['reduce', false],
      ['no-preference', true],
    ]) {
      await page.emulateMedia({ reducedMotion });
      await waitForScrollIdle();
      const animation = await page.evaluate((interrupt) => {
        const scroll = document.querySelector('.message-scroll');
        const saved = window.timelineTest.capture();
        const start = scroll.scrollTop;
        // 固定动画帧时间，避免宿主繁忙时一帧跨过整段缓动。
        const request = window.requestAnimationFrame;
        const cancel = window.cancelAnimationFrame;
        const callbacks = new Map();
        let nextId = 0;
        window.requestAnimationFrame = (callback) => {
          callbacks.set(++nextId, callback);
          return nextId;
        };
        window.cancelAnimationFrame = (id) => void callbacks.delete(id);
        const frame = (time) => {
          for (const [id, callback] of [...callbacks]) {
            if (callbacks.delete(id)) callback(time);
          }
          return start - scroll.scrollTop;
        };
        try {
          const time = performance.now();
          window.timelineTest.restore({ ...saved, offset: saved.offset + 40 }, true);
          const immediate = start - scroll.scrollTop;
          const intermediate = frame(time + 32);
          if (interrupt)
            scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 10 }));
          return { immediate, intermediate, final: frame(time + 150) };
        } finally {
          window.requestAnimationFrame = request;
          window.cancelAnimationFrame = cancel;
        }
      }, interrupt);
      if (reducedMotion === 'reduce') {
        assert.ok(Math.abs(animation.immediate - 40) <= 1, '启用减少动态效果时应立即定位');
      } else {
        assert.ok(Math.abs(animation.immediate) <= 1, '缓动开始时位置突然跳变');
        assert.ok(animation.intermediate > 1 && animation.intermediate < 39, '缺少缓动中间帧');
        const expected = interrupt ? animation.intermediate : 40;
        assert.ok(Math.abs(animation.final - expected) <= 1, '缓动未收敛或被滚轮打断');
      }
    }
    await page.evaluate(() => window.timelineTest.jump('row-1175'));
    await media.waitFor({ state: 'detached' });
    await page.evaluate(() => window.timelineTest.jump('row-1102'));
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-message-id="row-1102"] img.qq-media-image');
      return image?.getBoundingClientRect().height === 360;
    });
    console.log(
      JSON.stringify({ delayedImageHeight: after.image.height, backwardAnchorDrift: drift }),
    );
  }
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
