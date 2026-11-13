import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const css = (
  await Promise.all(
    ['im-template/styles/chat.css', 'styles/message-repeat.css'].map((path) =>
      readFile(resolve(root, 'src/renderer/src', path), 'utf8'),
    ),
  )
).join('\n');
const output = process.env.WEQ_REPEAT_ARTIFACTS;
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
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.body.style.cssText = `
            margin:24px;font-family:Arial,sans-serif;
            background:${theme === 'dark' ? '#222' : '#f7f7f7'};
            --weq-fg-primary:${theme === 'dark' ? '#eee' : '#111'};
            --weq-fg-secondary:${theme === 'dark' ? '#bbb' : '#666'};
            --weq-bg-surface:${theme === 'dark' ? '#333' : '#fff'};
            --weq-border-strong:${theme === 'dark' ? '#666' : '#ccc'};
            --weq-chat-bubble-other:var(--weq-bg-surface);`;
          // 对应 MessageBubble 的层级，名称与时间不参与正文的居中计算。
          for (const side of ['theirs', 'mine']) {
            for (const heading of ['', 'Lv17 · 白银　发送者　seq 7254']) {
              for (const text of ['过早', '第一行\n第二行\n第三行']) {
                const line = document.createElement('div');
                line.className = `message-line ${side}`;
                line.style.marginBottom = '16px';
                line.innerHTML = `
                  <div class="message-bubble">
                    <div class="weq-message-heading"><span class="message-name"></span></div>
                    <div class="weq-repeat-content">
                      <div class="message-content"></div>
                      <button type="button" class="weq-message-repeat">+1</button>
                    </div>
                  </div>`;
                line.querySelector('.message-name').textContent = heading;
                const content = line.querySelector('.message-content');
                content.style.whiteSpace = 'pre-wrap';
                content.textContent = text;
                document.body.append(line);
              }
            }
          }
        }, theme);
        const metrics = await page.locator('.message-line').evaluateAll((lines) =>
          lines.map((line) => {
            const content = line.querySelector('.message-content').getBoundingClientRect();
            const button = line.querySelector('.weq-message-repeat').getBoundingClientRect();
            return {
              side: line.classList.contains('mine') ? 'mine' : 'theirs',
              text: line.querySelector('.message-content').textContent,
              dy: button.y + button.height / 2 - content.y - content.height / 2,
              gap: line.classList.contains('mine')
                ? content.left - button.right
                : button.left - content.right,
            };
          }),
        );
        for (const metric of metrics) {
          assert.ok(Math.abs(metric.dy) < 0.1, JSON.stringify({ width, theme, ...metric }));
          assert.ok(metric.gap >= 0, JSON.stringify(metric));
        }
        cases += metrics.length;
        if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      } finally {
        await page.close();
      }
    }
  }
  console.log(`PASS ${cases} message repeat alignment cases`);
} finally {
  await browser.close();
}
