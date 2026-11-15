import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoaderCircle } from 'lucide-react';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const css = (
  await Promise.all(
    [
      'im-template/styles/chat.css',
      'styles/message-repeat.css',
      'styles/chat-interactions.css',
      'styles/message-metadata.css',
    ].map((path) => readFile(resolve(root, 'src/renderer/src', path), 'utf8')),
  )
).join('\n');
const output = process.env.WEQ_REPEAT_ARTIFACTS;
const spinner = renderToStaticMarkup(
  createElement(LoaderCircle, { size: 16, 'aria-hidden': true }),
);
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WEQ_BROWSER_EXECUTABLE
    ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
    : {}),
});
try {
  let cases = 0;
  for (const width of [390, 1200]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent('<!doctype html><meta charset="utf-8">');
        await page.addStyleTag({ content: css });
        await page.evaluate(
          ({ theme, spinner }) => {
            document.documentElement.dataset.theme = theme;
            document.body.style.cssText = `
            margin:24px;font-family:Arial,sans-serif;
            background:${theme === 'dark' ? '#222' : '#f7f7f7'};
            --weq-fg-primary:${theme === 'dark' ? '#eee' : '#111'};
            --weq-fg-secondary:${theme === 'dark' ? '#bbb' : '#666'};
            color:var(--weq-fg-primary);
            --weq-bg-surface:${theme === 'dark' ? '#333' : '#fff'};
            --weq-border-strong:${theme === 'dark' ? '#666' : '#ccc'};
            --weq-chat-bubble-other:var(--weq-bg-surface);`;
            // 对应 MessageBubble 的层级，名称与时间不参与正文的居中计算。
            for (const control of ['sending', 'repeat']) {
              for (const side of ['theirs', 'mine']) {
                for (const heading of ['', 'Lv17 · 白银　发送者　seq 7254']) {
                  for (const text of ['过早', '第一行\n第二行\n第三行', '媒体']) {
                    const line = document.createElement('div');
                    line.className = `message-line ${side}`;
                    line.style.marginBottom = '16px';
                    line.innerHTML = `
                  <div class="message-bubble">
                    <div class="weq-message-heading"><span class="message-name"></span><span class="weq-message-provenance">2026-11-15 19:00:00</span></div>
                    <div class="weq-repeat-content">
                      <div class="message-content"></div>
                      ${control === 'sending' ? `<span class="weq-message-sending" role="status" aria-label="发送中">${spinner}</span>` : '<button type="button" class="weq-message-repeat">+1</button>'}
                    </div>
                    ${heading ? '<div style="height:48px">下方附加内容</div>' : ''}
                  </div>`;
                    line.querySelector('.message-name').textContent = heading;
                    const content = line.querySelector('.message-content');
                    content.style.whiteSpace = 'pre-wrap';
                    content.textContent = text;
                    if (text === '媒体') content.style.cssText += ';width:120px;height:120px';
                    document.body.append(line);
                  }
                }
              }
            }
          },
          { theme, spinner },
        );
        const metrics = await page.locator('.message-line').evaluateAll((lines) =>
          lines.map((line) => {
            const content = line.querySelector('.message-content').getBoundingClientRect();
            const action = line.querySelector('.weq-message-repeat, .weq-message-sending');
            const button = action.getBoundingClientRect();
            return {
              control: action.className,
              side: line.classList.contains('mine') ? 'mine' : 'theirs',
              text: line.querySelector('.message-content').textContent,
              dy: button.y + button.height / 2 - content.y - content.height / 2,
              gap: line.classList.contains('mine')
                ? content.left - button.right
                : button.left - content.right,
              left: button.left,
              right: button.right,
            };
          }),
        );
        for (const metric of metrics) {
          assert.ok(Math.abs(metric.dy) < 0.1, JSON.stringify({ width, theme, ...metric }));
          assert.ok(metric.gap >= 0, JSON.stringify(metric));
          assert.ok(metric.left >= 0 && metric.right <= width, JSON.stringify(metric));
        }
        if (output) {
          await page.locator('.message-line.mine').nth(2).scrollIntoViewIfNeeded();
          await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
        }
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.ok(
          await page
            .locator('.weq-message-sending svg')
            .evaluateAll((icons) =>
              icons.every((icon) => getComputedStyle(icon).animationName === 'none'),
            ),
          '减少动态效果时发送圈停止旋转',
        );
        const transitions = await page.locator('.weq-message-sending').evaluateAll((spinners) =>
          spinners.map((spinner) => {
            const before = spinner.getBoundingClientRect();
            const content = spinner.parentElement.querySelector('.message-content');
            const beforeContent = content.getBoundingClientRect();
            const button = document.createElement('button');
            button.className = 'weq-message-repeat';
            button.textContent = '+1';
            spinner.replaceWith(button);
            const after = button.getBoundingClientRect();
            const afterContent = content.getBoundingClientRect();
            return {
              dx: before.x + before.width / 2 - after.x - after.width / 2,
              dy: before.y + before.height / 2 - after.y - after.height / 2,
              bodyDx: beforeContent.x - afterContent.x,
              bodyDy: beforeContent.y - afterContent.y,
            };
          }),
        );
        assert.ok(
          transitions.every((row) => Object.values(row).every((value) => Math.abs(value) < 0.1)),
        );
        cases += metrics.length;
      } finally {
        await page.close();
      }
    }
  }
  console.log(`PASS ${cases} message repeat/sending alignment cases and slot transitions`);
} finally {
  await browser.close();
}
