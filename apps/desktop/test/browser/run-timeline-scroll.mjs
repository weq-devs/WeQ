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
const { chromium, webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
await mkdir(resolve(root, 'node_modules/.cache'), { recursive: true });
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/timeline-scroll-'));
const baseline = process.env.WEQ_TIMELINE_BASELINE_REF;
const width = Number(process.env.WEQ_SCROLL_WIDTH ?? 1280);
const cachedBubbles = process.env.WEQ_SCROLL_CACHED_BUBBLES === '1';
const grouped = process.env.WEQ_SCROLL_GROUPED === '1';
const imageGrid = process.env.WEQ_SCROLL_IMAGE_GRID === '1';
const touchReply = process.env.WEQ_SCROLL_TOUCH_REPLY === '1';
const gapRecovery = process.env.WEQ_SCROLL_GAP_RECOVERY === '1';
const layoutMotion = process.env.WEQ_SCROLL_LAYOUT_MOTION === '1';
const browserType = gapRecovery || process.env.WEQ_SCROLL_BROWSER === 'webkit' ? webkit : chromium;
const fixtureFlags = [
  cachedBubbles && '&cached-bubbles=1',
  (grouped || touchReply) && '&grouped=1',
  (imageGrid || touchReply) && '&image-grid=1',
  touchReply && '&show-message-seq=1&touch-reply=1',
]
  .filter(Boolean)
  .join('');
const server = await createServer({
  configFile: false,
  root,
  define:
    touchReply || gapRecovery || layoutMotion
      ? { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') }
      : undefined,
  cacheDir,
  optimizeDeps: {
    entries: [
      'test/browser/timeline.html',
      ...(layoutMotion ? ['test/browser/conversation-list-states.html'] : []),
    ],
  },
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
  browser = await browserType.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width, height: gapRecovery ? 620 : 900 },
    isMobile: touchReply || gapRecovery,
    hasTouch: touchReply || gapRecovery,
    ...(gapRecovery
      ? {
          userAgent: 'Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 WeQRemote',
        }
      : {}),
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  if (gapRecovery) await checkGapRecovery(page);
  else if (layoutMotion) await checkLayoutMotion(page);
  else await checkScroll(page);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

async function checkLayoutMotion(page) {
  page.setDefaultTimeout(10_000);
  const base = `http://127.0.0.1:${server.httpServer.address().port}/test/browser`;
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    window.rowMotion = [];
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      const key =
        this.closest('[data-weq-motion-key]')?.dataset.weqMotionKey ??
        this.closest('[data-weq-layout-row]')?.dataset.weqLayoutRow;
      if (key) {
        const frames = animation.effect.getKeyframes();
        if (window.holdRowMotion === key && frames[0].transform) {
          window.holdRowMotion = undefined;
          animation.pause();
          animation.currentTime = 50;
        }
        const property = frames[0].transform ? 'transform' : 'opacity';
        const values = animation.ready.then(
          async () => {
            const samples = [];
            for (let frame = 0; frame < 5; frame++) {
              await new Promise(requestAnimationFrame);
              samples.push(getComputedStyle(this)[property]);
            }
            return samples;
          },
          () => [],
        );
        window.rowMotion.push({ key, target: this, animation, frames, values });
      }
      return animation;
    };
  });
  const sample = (key, selector) =>
    page.evaluate(
      async ({ key, selector }) => {
        const run = [...window.rowMotion]
          .reverse()
          .find((entry) => entry.key === key && entry.target.matches(selector));
        return run ? { frames: run.frames, values: await run.values } : null;
      },
      { key, selector },
    );
  const clear = () =>
    page.evaluate(() => {
      window.rowMotion.length = 0;
    });
  const logs = () =>
    page.evaluate(() => window.rowMotion.map(({ key, target }) => [key, target.className]));
  const order = (ids) =>
    page.waitForFunction(
      (ids) =>
        [...document.querySelectorAll('[data-weq-layout-row]')]
          .map((row) => row.dataset.weqLayoutRow)
          .join(',') === ids.join(','),
      ids,
    );
  const near = (a, b) => assert.ok(Math.abs(a - b) <= 1, `阅读锚点发生变化：${a} -> ${b}`);
  const sameEdge = (a, b) => assert.ok(Math.abs(a - b) <= 2, `消息下沿锚点发生变化：${a} -> ${b}`);

  for (const reducedMotion of ['no-preference', 'reduce']) {
    const reduced = reducedMotion === 'reduce';
    await page.emulateMedia({ reducedMotion });
    await page.goto(`${base}/timeline.html?count=180&entry&send-motion`);
    const message = (id) => page.locator(`.message-line[data-message-id="${id}"]`);
    const viewport = page.locator('.message-scroll');
    const bottom = () =>
      page.waitForFunction(() => {
        const scroll = document.querySelector('.message-scroll');
        return scroll && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2;
      });
    await message('row-1180').waitFor();
    await bottom();
    assert.deepEqual(await logs(), [], '初次加载不播入场');
    const previousTail = message('row-1180');
    const oldTop = (await previousTail.boundingBox()).y;
    await page.evaluate(() => {
      window.holdRowMotion = 'row-1180';
    });
    const composer = page.getByRole('textbox').last();
    await composer.fill('真实发送入口的本地回显');
    await composer.press('Enter');
    await message('row-1181').waitFor();
    await page.getByText('真实发送入口的本地回显', { exact: true }).waitFor();
    const arrival = await sample('row-1181', '.message-line');
    if (reduced) {
      assert.equal(arrival, null);
      assert.equal(await sample('row-1180', '.weq-virtual-timeline-row'), null);
    } else {
      assert.equal(arrival?.frames[0].opacity, '0.75');
      assert.match(arrival?.frames[0].transform, /translateY\([1-9]/, '新气泡应有实际位移');
      assert.ok(new Set(arrival.values).size > 1, '新气泡应有实际移动的中间帧');
      const previous = await page.evaluate(() => {
        const run = window.rowMotion.find(
          ({ key, target }) =>
            key === 'row-1180' && target.classList.contains('weq-virtual-timeline-row'),
        );
        if (!run) return null;
        run.animation.currentTime = 0;
        const start = run.target.getBoundingClientRect().top;
        const line = run.target.querySelector('.message-line');
        const inset = line.getBoundingClientRect().top - start;
        run.animation.currentTime = 80;
        const middle = line.getBoundingClientRect().top;
        run.animation.finish();
        return { start: start + inset, middle, end: line.getBoundingClientRect().top };
      });
      assert.ok(previous, '即时贴底时上一条消息也应过渡');
      near(previous.start, oldTop);
      assert.ok(previous.start > previous.middle && previous.middle > previous.end);
    }
    await bottom();
    await clear();
    await page.evaluate(() => window.timelineTest.confirmTail());
    await message('row-1181-confirmed').waitFor();
    assert.equal(await sample('row-1181', '.message-line'), null, '发送回执不重复播放入场');
    await page.evaluate(() => window.timelineTest.jump('row-1070'));
    await message('row-1070').waitFor();
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-message-id="row-1070"]')?.getBoundingClientRect();
      const scroll = document.querySelector('.message-scroll').getBoundingClientRect();
      return row && row.top > scroll.top && row.bottom < scroll.bottom;
    });
    const belowRecall = (await message('row-1071').boundingBox()).y;
    await clear();
    await page.evaluate(() => window.timelineTest.append());
    await page.evaluate(() => window.timelineTest.recall('row-1070'));
    await message('row-1070').locator('.weq-msg-recall-tag').waitFor();
    assert.equal(await sample('row-1182', '.message-line'), null, '阅读历史不播放实时消息入场');
    sameEdge(belowRecall, (await message('row-1071').boundingBox()).y);
    assert.equal(
      (await logs()).some(
        ([key, target]) => key === 'row-1070' && target.includes('weq-msg-recall-tag'),
      ),
      !reduced,
    );
    await clear();
    await page.evaluate(() => window.timelineTest.delete('row-1070'));
    await message('row-1070').locator('.weq-msg-deleted-veil').waitFor();
    assert.equal(
      (await logs()).some(
        ([key, target]) => key === 'row-1070' && target.includes('weq-msg-deleted-veil'),
      ),
      !reduced,
    );
    await viewport.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const anchor = await page.evaluate(() => window.timelineTest.capture());
    const anchorTop = (await message(anchor.anchorId).boundingBox()).y;
    await clear();
    await page.evaluate(() => window.timelineTest.hideDeleted('row-1070'));
    await message('row-1070').waitFor({ state: 'detached' });
    near(anchorTop, (await message(anchor.anchorId).boundingBox()).y);
    assert.equal(
      (await logs()).some(([key]) => key === 'row-1071'),
      !reduced,
    );
    await clear();
    await page.evaluate(() => window.timelineTest.restoreDeleted());
    await message('row-1070').waitFor();
    assert.equal(
      (await logs()).some(([key]) => key === 'row-1070'),
      !reduced,
    );
    near(anchorTop, (await message(anchor.anchorId).boundingBox()).y);
    await clear();
    const belowTip = (await message('row-1073').boundingBox()).y;
    await page.evaluate(() => window.timelineTest.recallTip('row-1072'));
    await page.locator('.weq-system-message-row[data-message-id="row-1072"]').waitFor();
    assert.equal(
      (await logs()).some(
        ([key, target]) => key === 'row-1072' && target.includes('weq-system-message-row'),
      ),
      !reduced,
    );
    sameEdge(belowTip, (await message('row-1073').boundingBox()).y);
    const top = await viewport.evaluate((node) => node.scrollTop);
    await viewport.evaluate((node) => {
      node.scrollTop += 45;
    });
    await page.waitForFunction(
      (top) => document.querySelector('.message-scroll').scrollTop > top,
      top,
    );

    await page.goto(`${base}/timeline.html?count=180&entry&motion-details&motion-unread=1181`);
    await message('row-1180').waitFor();
    await bottom();
    await page.evaluate(() => window.timelineTest.append());
    const incoming = message('row-1181');
    await incoming.waitFor();
    await page.getByText('以下为未读消息').waitFor();
    const incomingMotion = await sample('row-1181', '.message-line');
    if (reduced) assert.equal(incomingMotion, null);
    else {
      assert.match(incomingMotion?.frames[0].transform, /translateY\([1-9]/);
      assert.ok(new Set(incomingMotion.values).size > 1, '对方来信有未读分隔也应有中间帧');
    }

    const centerMessage = async (id) => {
      await page.evaluate((id) => window.timelineTest.jump(id), id);
      await page.waitForFunction((id) => {
        const row = document.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect();
        const scroll = document.querySelector('.message-scroll')?.getBoundingClientRect();
        return (
          row && scroll && Math.abs(row.top + row.height / 2 - scroll.top - scroll.height / 2) < 20
        );
      }, id);
    };
    await centerMessage('row-1070');
    const topOf = async (id) => (await message(id).boundingBox()).y;
    const showResultMenu = async (result) => {
      await result.evaluate(async (element) => {
        // 等锚点补偿的原生 scroll 已派发，再触发菜单的键盘入口。
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        element.focus({ preventScroll: true });
        element.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }),
        );
      });
      const collapse = page.getByRole('menuitem', { name: '收起', exact: true });
      await collapse.waitFor();
      return () => collapse.evaluate((button) => button.click());
    };
    const detailChange = async (id, below, above, direction, trigger, check) => {
      await clear();
      const before = await page.evaluate(
        async ({ id, below, above }) => {
          // 定向跳转的最后一轮原生滚动校准完成后再采集初始帧。
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          const top = (id) =>
            document.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top;
          window.holdRowMotion = id;
          return { row: top(id), above: top(above), below: top(below) };
        },
        { id, below, above },
      );
      await trigger();
      await check();
      const frames = await page.evaluate(
        ({ id, below, above }) => {
          const find = (key) =>
            window.rowMotion.find(
              (entry) =>
                entry.key === key &&
                entry.frames[0].transform &&
                (entry.target.classList.contains('weq-virtual-timeline-row') ||
                  entry.target.classList.contains('message-line')),
            )?.animation;
          const top = (id) =>
            document.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top;
          const animations = [find(id), find(above)].filter(Boolean);
          if (animations.length === 0) return null;
          for (const animation of animations) animation.pause();
          const frames = [0, 60, 160].map((time) => {
            for (const animation of animations) animation.currentTime = time;
            return { row: top(id), above: top(above), below: top(below) };
          });
          for (const animation of animations) animation.finish();
          return frames;
        },
        { id, below, above },
      );
      if (reduced) assert.equal(frames, null);
      else {
        assert.ok(frames, `${id} 的附加内容缺少缓动`);
        assert.ok(
          Math.abs(frames[0].row - before.row) <= 2,
          `${id} 首帧偏移：${JSON.stringify({ before, frames })}`,
        );
        sameEdge(frames[0].above, before.above);
        for (const frame of frames) sameEdge(frame.below, before.below);
        for (const key of ['row', 'above']) {
          assert.ok(direction * (frames[1][key] - frames[0][key]) > 0);
          assert.ok(direction * (frames[2][key] - frames[1][key]) > 0);
        }
      }
      sameEdge(await topOf(below), before.below);
      assert.ok(direction * ((await topOf(id)) - before.row) > 0);
    };

    const translation = page.getByRole('group', { name: '译文' });
    await message('row-1070').locator('.message-bubble').click({ button: 'right' });
    await detailChange(
      'row-1070',
      'row-1071',
      'row-1069',
      -1,
      () => page.getByRole('menuitem', { name: '翻译成中文' }).click(),
      () => translation.getByText('正在翻译…').waitFor(),
    );
    await detailChange(
      'row-1070',
      'row-1071',
      'row-1069',
      -1,
      () => page.evaluate(() => window.timelineTest.completeTranslation()),
      () => translation.getByText(/多行译文/).waitFor(),
    );
    const collapseTranslation = await showResultMenu(translation);
    await detailChange('row-1070', 'row-1071', 'row-1069', 1, collapseTranslation, () =>
      translation.waitFor({ state: 'detached' }),
    );
    const transcript = page.getByRole('group', { name: '转文字结果' });
    await centerMessage('row-1073');
    await detailChange(
      'row-1073',
      'row-1074',
      'row-1072',
      -1,
      () =>
        message('row-1073')
          .getByRole('button', { name: '转文字' })
          .evaluate((button) => button.click()),
      () => transcript.waitFor(),
    );
    const collapseTranscript = await showResultMenu(transcript);
    await detailChange('row-1073', 'row-1074', 'row-1072', 1, collapseTranscript, () =>
      transcript.waitFor({ state: 'detached' }),
    );
    await detailChange(
      'row-1073',
      'row-1074',
      'row-1072',
      -1,
      () =>
        message('row-1073')
          .getByRole('button', { name: '展开文字' })
          .evaluate((button) => button.click()),
      () => transcript.waitFor(),
    );
    await centerMessage('row-1075');
    await detailChange(
      'row-1075',
      'row-1076',
      'row-1074',
      -1,
      () => page.evaluate(() => window.timelineTest.failSend('row-1075')),
      () => message('row-1075').getByRole('button', { name: '重试发送' }).waitFor(),
    );

    await page.goto(`${base}/timeline.html?count=4&first=1073&entry&motion-details`);
    await message('row-1076').waitFor();
    await detailChange(
      'row-1075',
      'row-1076',
      'row-1074',
      -1,
      () => page.evaluate(() => window.timelineTest.failSend('row-1075')),
      () => message('row-1075').getByRole('button', { name: '重试发送' }).waitFor(),
    );

    await page.goto(`${base}/conversation-list-states.html`);
    await order(['10001', '10003', '10002']);
    assert.deepEqual(await logs(), [], '列表首次出现不播入场');
    await page.evaluate(() => window.conversationStatesQa.promote());
    await order(['10002', '10001', '10003']);
    const move = await sample('10002', '[data-weq-layout-row]');
    if (reduced) assert.equal(move, null);
    else {
      assert.match(move?.frames[0].transform, /translateY/);
      assert.ok(new Set(move.values).size > 1, '会话移动缺少中间帧');
    }
    await page.evaluate(() => window.conversationStatesQa.reset());
    await order(['10001', '10003', '10002']);
    if (!reduced) {
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('[data-weq-layout-row="10002"]')).transform ===
          'none',
      );
      await clear();
      await page.evaluate(() => {
        window.holdRowMotion = '10002';
        window.conversationStatesQa.promote();
      });
      await order(['10002', '10001', '10003']);
      const interruptedAt = await page.evaluate(() => {
        const run = window.rowMotion.find(({ key }) => key === '10002');
        const top = run.target.getBoundingClientRect().top;
        window.conversationStatesQa.reset();
        return top;
      });
      await order(['10001', '10003', '10002']);
      const resumedAt = await page.evaluate(() => {
        const last = window.rowMotion.filter(({ key }) => key === '10002').at(-1);
        if (window.rowMotion.find(({ key }) => key === '10002').animation.playState !== 'idle')
          throw new Error('重新排序后旧动效仍在运行');
        if (!last.frames[0].transform) throw new Error('重新排序后缺少接续位移');
        return (
          last.target.parentElement.getBoundingClientRect().top +
          last.target.offsetTop +
          Number.parseFloat(last.frames[0].transform.slice('translateY('.length))
        );
      });
      near(interruptedAt, resumedAt);
    }
    await clear();
    await page.evaluate(() => window.conversationStatesQa.removeFirst());
    await order(['10003', '10002']);
    assert.equal(
      (await logs()).some(([key]) => key === '10003'),
      !reduced,
    );
    await clear();
    await page.evaluate(() => window.conversationStatesQa.reset());
    await order(['10001', '10003', '10002']);
    assert.equal(
      (await logs()).some(([key]) => key === '10001'),
      !reduced,
    );
    await page.evaluate(() => window.conversationStatesQa.distantOrder(true));
    const otherIds = ['20001', '20002', '20003', '20004', '20005', '20006'];
    await order(['10001', ...otherIds]);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-weq-layout-row]')].every(
        (row) => row.getAnimations().length === 0,
      ),
    );
    await clear();
    await page.evaluate(() => window.conversationStatesQa.distantOrder(false));
    await order([...otherIds, '10001']);
    const distantMove = await sample('10001', '[data-weq-layout-row]');
    if (reduced) assert.equal(distantMove, null);
    else {
      assert.equal(distantMove?.frames[0].opacity, '0.75', '长距离下移也要过渡到新位置');
      assert.ok(distantMove.values.some((value) => Number(value) > 0.75 && Number(value) < 1));
    }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${base}/timeline.html?count=0&entry&send-motion`);
  await page.getByText('还没有消息', { exact: true }).waitFor();
  const composer = page.getByRole('textbox').last();
  await composer.fill('空会话的第一条消息');
  await composer.press('Enter');
  await page.getByText('空会话的第一条消息', { exact: true }).waitFor();
  const first = await sample('row-1001', '.message-line');
  assert.match(first?.frames[0].transform, /translateY\([1-9]/);
  console.log('实时收发、撤回与删除、译文与转写、发送失败、会话移位及减少动态效果通过');
}

async function checkGapRecovery(page) {
  page.setDefaultTimeout(10_000);
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?count=180&mobile-input&gap-recovery`,
  );
  await page.waitForFunction(() => window.timelineTest?.capture);
  const scroll = page.locator('.message-scroll');
  const row = (seq) => page.locator(`[data-message-id="row-${seq}"]`);
  const tail = row(1180);
  const settle = () =>
    scroll.evaluate(
      (element) =>
        new Promise((resolve) => {
          let previous = '';
          let steady = 0;
          const sample = () => {
            const geometry = `${element.scrollTop}:${element.scrollHeight}:${element.clientHeight}`;
            steady = geometry === previous ? steady + 1 : 0;
            previous = geometry;
            if (steady >= 4) resolve();
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
    );
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 76;
  });
  await tail.waitFor();
  await settle();
  const beforeTail = await tail.boundingBox();
  await page.evaluate(() => window.timelineTest.growTail());
  await page.waitForFunction(() => {
    const last = document.querySelector('[data-message-id="row-1180"]').parentElement;
    return (
      Number.parseFloat(last.parentElement.style.height) >= last.offsetTop + last.offsetHeight - 1
    );
  });
  const afterTail = await tail.boundingBox();
  const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${label}: ${a} -> ${b}`);
  near(beforeTail.y, afterTail.y, '尚未滚到底时，末行增高拉动了视口');
  await scroll.press('End');
  await page.waitForFunction(() => {
    const viewport = document.querySelector('.message-scroll').getBoundingClientRect();
    return (
      document.querySelector('[data-message-id="row-1180"]').getBoundingClientRect().bottom <=
      viewport.bottom
    );
  });

  const gap = page.locator('[data-message-id="gap:1080:1084"]');
  const positionRow = async (seq) => {
    await page.evaluate((id) => window.timelineTest.jump(id), `row-${seq}`);
    await page.waitForFunction((id) => {
      const viewport = document.querySelector('.message-scroll');
      const rect = viewport.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect();
      return (
        rect &&
        Math.abs(
          (rect.top + rect.bottom) / 2 -
            viewport.getBoundingClientRect().top -
            viewport.clientHeight / 2,
        ) <= 1
      );
    }, `row-${seq}`);
    await row(seq).evaluate((element) => {
      const viewport = element.closest('.message-scroll');
      viewport.scrollTop +=
        element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 6;
    });
    await page.waitForFunction((id) => window.timelineTest.capture().anchorId === id, `row-${seq}`);
    await settle();
  };
  await page.evaluate(() => window.timelineTest.makeGap());
  await positionRow(1084);
  const beforeGap = await row(1084).boundingBox();
  await page.evaluate(() => window.timelineTest.closeGap());
  await gap.waitFor({ state: 'detached' });
  const afterGap = await row(1084).boundingBox();
  near(beforeGap.y, afterGap.y, '缺口收起改变了阅读位置');
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    await page.evaluate(() => window.timelineTest.makeGap());
    await positionRow(1080);
    await gap.waitFor();
    const before = await row(1080).boundingBox();
    const frames = await page.evaluate(() => {
      const gap = document.querySelector('[data-message-id="gap:1080:1084"] button');
      const visible = ['row-1081', 'row-1082', 'row-1083'];
      return new Promise((resolve, reject) => {
        const frames = [];
        const deadline = performance.now() + 2000;
        const sample = () => {
          if (performance.now() > deadline) {
            reject(new Error('缺口补回未完成'));
            return;
          }
          const rows = visible.map((id) => document.querySelector(`[data-message-id="${id}"]`));
          if (rows.every(Boolean)) {
            frames.push(rows.map((element) => Number(getComputedStyle(element).opacity)));
            if (frames.length > 1 && frames.at(-1).every((opacity) => opacity === 1)) {
              resolve(frames);
              return;
            }
          }
          requestAnimationFrame(sample);
        };
        gap.click();
        requestAnimationFrame(sample);
      });
    });
    near(before.y, (await row(1080).boundingBox()).y, '补回缺口移动了在读消息');
    if (reducedMotion === 'reduce')
      assert.ok(frames.every((frame) => frame.every((opacity) => opacity === 1)));
    else {
      assert.ok(
        frames[0].every((opacity) => opacity >= 0.75 && opacity < 1),
        JSON.stringify(frames),
      );
      assert.ok(
        frames
          .slice(1, -1)
          .some((frame) => frame.every((opacity, i) => opacity > frames[0][i] && opacity < 1)),
        JSON.stringify(frames),
      );
    }
    await row(1082).locator('button.qq-media-wrap').waitFor();
    assert.match(await row(1083).textContent(), /合成系统消息/);
  }
  console.log(
    JSON.stringify({ tailDrift: afterTail.y - beforeTail.y, gapDrift: afterGap.y - beforeGap.y }),
  );
}

async function checkScroll(page) {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?count=25${fixtureFlags}`,
  );
  await page.waitForSelector('[data-message-id="row-1001"]');
  if (touchReply) {
    const cdp = await page.context().newCDPSession(page);
    const first = page.locator('[data-message-id="row-1003"]');
    const last = page.locator('[data-message-id="row-1004"]');
    const text = first.locator('.qq-reply-body');
    const quotePreview = first.getByRole('button', { name: /合成消息 1001/ });
    const original = page.locator('[data-message-id="row-1001"]');
    const avatar = first.locator('.avatar');
    const meta = first.locator('.weq-message-provenance');
    const image = last.locator('button.qq-media-wrap').first();
    const arrow = first.locator('.weq-swipe-reply-icon');
    const scroll = page.locator('.message-scroll');
    const xOf = (locator) => locator.evaluate((element) => element.getBoundingClientRect().x);
    const waitForX = async (locator, x) =>
      page.waitForFunction(
        ([element, x]) => Math.abs(element.getBoundingClientRect().x - x) < 0.5,
        [await locator.elementHandle(), x],
      );
    const near = (actual, expected) =>
      assert.ok(Math.abs(actual - expected) < 1, `${actual} ≠ ${expected}`);
    const swipe = async (target, dx, dy, { onMove, beforeStart, slowStart } = {}) => {
      await target.scrollIntoViewIfNeeded();
      const bounds = await target.boundingBox();
      await beforeStart?.();
      const x = bounds.x + Math.min(80, bounds.width / 2);
      const y = bounds.y + bounds.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      if (slowStart) {
        // 前 500 ms 内缓慢左移，但还没到消息开始跟手的距离。
        for (const distance of [3, 6, 9]) {
          await new Promise((resolve) => setTimeout(resolve, 130));
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x - distance, y }],
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: x + dx * fraction, y: y + dy * fraction }],
        });
        if (onMove) {
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          await onMove(fraction, bounds);
        }
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const quote = page.getByLabel('待发送的引用');
    await text.scrollIntoViewIfNeeded();
    const before = await scroll.evaluate((element) => element.scrollTop);
    await swipe(text, 0, -100);
    await page.waitForFunction(
      (top) => document.querySelector('.message-scroll').scrollTop > top + 5,
      before,
    );
    assert.equal(await quote.count(), 0);
    let start;
    await swipe(image, -36, 0, {
      onMove: async (fraction, bounds) => {
        if (fraction !== 1) return;
        near(await xOf(image), bounds.x - 36);
        near(await xOf(avatar), start.avatar);
      },
      beforeStart: async () => {
        start = { avatar: await xOf(avatar), image: await xOf(image) };
      },
    });
    assert.equal(await quote.count(), 0);
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    await waitForX(image, start.image);

    const parts = [text, avatar, meta];
    let initial;
    await swipe(text, -52, 0, {
      onMove: async (fraction) => {
        if (fraction === 0.25) return;
        for (const [index, part] of parts.entries()) {
          near(await xOf(part), initial.parts[index] - 52 * fraction);
        }
        near(await xOf(last), initial.neighbor);
        near(await xOf(arrow), initial.edge - 52 * fraction);
        assert.equal(
          await arrow.evaluate((element) => getComputedStyle(element).visibility),
          'visible',
        );
      },
      beforeStart: async () => {
        initial = {
          parts: await Promise.all(parts.map(xOf)),
          neighbor: await xOf(last),
          edge: await scroll.evaluate((element) => element.getBoundingClientRect().right),
        };
        assert.equal(
          await arrow.evaluate((element) => getComputedStyle(element).visibility),
          'hidden',
        );
      },
    });
    await waitForX(text, initial.parts[0]);
    assert.equal(await quote.count(), 0);
    await swipe(quotePreview, -80, 0, {
      slowStart: true,
      onMove: async (fraction) => {
        if (fraction === 1) assert.equal(await quote.count(), 0);
      },
    });
    await quote.waitFor({ timeout: 3000 });
    assert.match(await quote.textContent(), /合成消息 1003/);
    assert.doesNotMatch(await quote.textContent(), /合成消息 1001/);
    assert.equal(
      await original.evaluate((el) => el.classList.contains('weq-reply-target-flash')),
      false,
    );
    const editor = page.locator('.composer-editor').first();
    assert.ok(await editor.evaluate((element) => document.activeElement === element));
    await page.keyboard.insertText('引用后直接输入');
    assert.match(await editor.textContent(), /引用后直接输入/);
    await quote.getByRole('button', { name: '取消引用' }).click();
    await quote.waitFor({ state: 'detached' });
    await quotePreview.tap();
    await page.waitForSelector('[data-message-id="row-1001"].weq-reply-target-flash');
    assert.equal(await quote.count(), 0);
    await cdp.detach();
    await page.reload();
    await page.waitForSelector('[data-message-id="row-1001"]');
  }
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
  if (!baseline) {
    await page.evaluate(() => {
      window.scrollProbe.phase = 'trim-cross-threshold';
      window.timelineTest.setCount(25);
    });
    await frames(4);
  }
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
      if (phase !== 'prepend-cross-threshold' && phase !== 'trim-cross-threshold') continue;
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
    touchReply,
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
}
