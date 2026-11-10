import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// 使用外部 Playwright 运行浏览器布局回归，不给产品增加依赖。
const require = createRequire(import.meta.url);
const { webkit } = require(process.env.WEQ_PLAYWRIGHT_MODULE || 'playwright');
const renderer = new URL('../apps/desktop/src/renderer/src/', import.meta.url);
const files = [
  'im-template/styles/base.css',
  'im-template/styles/chat.css',
  'im-template/styles/responsive.css',
  'im-template/styles/composer-media.css',
  'styles/message-metadata.css',
  'styles/intent-sense.css',
  'styles/mobile-web.css',
  'styles/conversation-actions.css',
  'styles/qqnt-appearance.css',
  'styles/new-message-preview.css',
];
let browser;
let css;
before(async () => {
  css = (await Promise.all(files.map((file) => readFile(new URL(file, renderer), 'utf8')))).join(
    '\n',
  );
  browser = await webkit.launch({
    headless: true,
    ...(process.env.WEQ_WEBKIT_EXECUTABLE
      ? { executablePath: process.env.WEQ_WEBKIT_EXECUTABLE }
      : {}),
  });
});
after(async () => browser?.close());

const text = '用于验证手机长引用与正文换行的合成消息'.repeat(12);
function fixture({ actions = true, suggest = true, quote = false } = {}) {
  return `<div class="app-shell-root weq-web-shell" data-mobile-detail>
    <div class="app-shell"><main class="chat-main chat-main-open"><section class="chat-pane">
      <header class="chat-header"><button class="back-button">返回</button>
        <div class="chat-title"><strong>合成群聊（102）</strong></div>
        <div class="chat-actions"><button class="icon-button">搜索</button>${actions ? '<button class="icon-button weq-conversation-message-actions">＋</button><button class="icon-button">群</button>' : ''}<button class="icon-button">⋯</button></div>
      </header>
      <div class="message-scroll"><div class="message-line"><div class="avatar">A</div>
        <div class="message-bubble"><div class="weq-message-heading">
          <span class="message-name"><span data-privacy-sensitive>${'合成昵称'.repeat(20)}</span></span>
          <span class="weq-message-provenance">seq 126409　21:20:10</span></div>
          <div class="message-content qq-has-reply"><button class="qq-reply-quote">
            <span class="qq-reply-quote-stack"><span class="qq-reply-quote-sender">合成引用</span>
            <span class="qq-reply-quote-body"><span>${text}</span></span></span></button>
            <span>${text}</span></div>
        </div></div></div>
      ${suggest ? `<div class="weq-int-suggest"><div class="weq-int-suggest-track"><button class="weq-int-suggest-pill">${text}</button></div><button class="weq-int-suggest-refresh">↻</button></div>` : ''}
      <footer class="composer${quote ? ' has-quote' : ''}">
        ${quote ? '<div class="composer-quote">合成待发送引用</div>' : ''}
        <div class="composer-editor" contenteditable="true"></div><div class="composer-tools"><button>工具</button></div>
      </footer>
    </section></main></div></div>`;
}

for (const width of [320, 402, 430, 760]) {
  for (const inset of [0, 62]) {
    test(`手机 ${width}px，顶部安全区 ${inset}px：顶栏可点击、消息不溢出`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 874 } });
      try {
        // 桌面 WebKit 不模拟刘海，显式注入尺寸以覆盖有/无安全区的反例。
        const styles = css
          .replaceAll('env(safe-area-inset-top, 0px)', `${inset}px`)
          .replaceAll('env(safe-area-inset-bottom, 0px)', '34px');
        for (const theme of ['light', 'dark']) {
          for (const component of ['default', 'qqnt']) {
            for (const state of [
              { actions: true, suggest: true },
              { actions: false, suggest: false },
              { actions: true, suggest: true, quote: true },
            ]) {
              await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1">
                <style>*{box-sizing:border-box}body{margin:0}${styles}</style>${fixture(state)}`);
              await page.evaluate(
                ({ theme, component }) => {
                  document.documentElement.dataset.theme = theme;
                  document.documentElement.dataset.componentStyle = component;
                },
                { theme, component },
              );
              for (const height of [874, 430]) {
                await page.setViewportSize({ width, height });
                const result = await page.evaluate(() => {
                  const rect = (selector) =>
                    document.querySelector(selector).getBoundingClientRect();
                  const header = rect('.chat-header');
                  const title = rect('.chat-title');
                  const scroll = document.querySelector('.message-scroll');
                  const content = rect('.message-content');
                  const bubble = rect('.message-bubble');
                  const composer = rect('.composer');
                  const editor = rect('.composer-editor');
                  const tools = rect('.composer-tools');
                  const button = document.querySelector('.chat-actions button');
                  const target = button.getBoundingClientRect();
                  const toolbar = rect('.chat-actions');
                  const buttons = [...document.querySelectorAll('.chat-actions > button')].map(
                    (element) => element.getBoundingClientRect(),
                  );
                  const gaps = buttons
                    .slice(1)
                    .map((button, index) => button.left - buttons[index].right);
                  return {
                    titleVisible: title.top >= 0 && title.bottom <= header.bottom,
                    toolsClickable: button.contains(
                      document.elementFromPoint(
                        target.x + target.width / 2,
                        target.y + target.height / 2,
                      ),
                    ),
                    scrollFits: scroll.scrollWidth <= scroll.clientWidth + 1,
                    contentFits: content.right <= bubble.right + 1,
                    toolbarDistributed:
                      buttons.length < 3 ||
                      (Math.abs(buttons[0].left - toolbar.left) <= 1 &&
                        Math.abs(buttons.at(-1).right - toolbar.right) <= 1 &&
                        Math.max(...gaps) - Math.min(...gaps) <= 1),
                    composerFits:
                      editor.height > 0 &&
                      composer.bottom <= innerHeight + 1 &&
                      editor.bottom <= tools.top + 1,
                  };
                });
                const context = JSON.stringify({ width, inset, theme, component, state, height });
                for (const [check, passed] of Object.entries(result))
                  assert.ok(passed, `${check}: ${context}`);
              }
            }
          }
        }
      } finally {
        await page.close();
      }
    });
  }
}

test('桌面长引用仍限制在气泡内，不改变桌面顶栏高度', async () => {
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  try {
    await page.setContent(
      `<style>*{box-sizing:border-box}body{margin:0}${css}
        .app-shell{grid-template-columns:minmax(0,1fr)}</style>${fixture()}`,
    );
    const result = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      return {
        headerHeight: rect('.chat-header').height,
        contentRight: rect('.message-content').right,
        bubbleRight: rect('.message-bubble').right,
      };
    });
    assert.equal(result.headerHeight, 40);
    assert.ok(result.contentRight <= result.bubbleRight + 1);
  } finally {
    await page.close();
  }
});

test('定位到最新按钮在手机群聊靠右，桌面仍避让群资料侧栏', async () => {
  const page = await browser.newPage();
  try {
    for (const width of [320, 402, 430, 760, 1180]) {
      await page.setViewportSize({ width, height: 874 });
      for (const groupState of ['', 'with-group-info', 'with-group-info group-info-collapsed']) {
        for (const theme of ['light', 'dark']) {
          for (const component of ['default', 'qqnt']) {
            await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}${css}
              .app-shell{grid-template-columns:minmax(0,1fr)}</style>${fixture({ suggest: false })}`);
            await page.evaluate(
              ({ groupState, theme, component }) => {
                document.documentElement.dataset.theme = theme;
                document.documentElement.dataset.componentStyle = component;
                const pane = document.querySelector('.chat-pane');
                pane.className = `chat-pane ${groupState}`;
                const pill = document.createElement('div');
                pill.className = 'new-message-pill';
                pill.innerHTML =
                  '<button class="new-message-preview">预览</button><button class="new-message-bottom">定位到底部</button>';
                pane.append(pill);
              },
              { groupState, theme, component },
            );
            const result = await page.evaluate(() => {
              const pane = document.querySelector('.chat-pane');
              const pill = document.querySelector('.new-message-pill');
              return {
                gap: pane.getBoundingClientRect().right - pill.getBoundingClientRect().right,
                panelWidth:
                  pane.getBoundingClientRect().right -
                  document.querySelector('.message-scroll').getBoundingClientRect().right,
                right: Number.parseFloat(getComputedStyle(pill).right),
              };
            });
            const expected =
              width <= 760 ? 24 : groupState === 'with-group-info' ? result.panelWidth + 16 : 24;
            const context = JSON.stringify({ width, groupState, theme, component, result });
            assert.ok(Math.abs(result.right - expected) <= 1, context);
            assert.ok(Math.abs(result.gap - expected) <= 1, context);
          }
        }
      }
    }
  } finally {
    await page.close();
  }
});
