import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const chat = await readFile(
  resolve(root, 'packages/service/src/account/export/html_exporter.ts'),
  'utf8',
);
const qzone = await readFile(
  resolve(root, 'packages/service/src/account/export/qzone_export.ts'),
  'utf8',
);
const style = (source, name) => {
  const match = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  assert.ok(match, `${name} 样式缺失`);
  return match[1];
};
const image = (width, height, attributes = '') => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#d73758"/></svg>`;
  return `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" ${attributes}>`;
};
const shapes = [
  [40, 160],
  [1200, 80],
  [80, 1200],
  [30, 30],
];
const chatImages = shapes
  .map(
    ([w, h]) => `
  <div class="msg"><div class="col"><div class="bubble">
    <span class="pic-wrap">${image(w, h, 'class="media"')}<small class="cap">很长的图片说明文字，不应把窄图片横向拉伸.jpg</small></span>
    ${image(w, h, 'class="media emoji"')}
    <div class="fwd"><div class="fwd-body">${image(w, h, 'class="media"')}</div></div>
    <div class="md-wrap">${image(w, h, 'width="200" height="200"')}</div>
  </div></div></div>`,
  )
  .join('');
const pictures = shapes.map(([w, h]) => `<a>${image(w, h)}</a>`).join('');
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  const output = process.env.WEQ_IMAGE_RATIO_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const [name, css, body] of [
        [
          'chat',
          style(chat, 'STYLE'),
          `<div class="frame"><main class="log">${chatImages}</main></div>`,
        ],
        [
          'qzone',
          style(qzone, 'QZONE_HTML_STYLE'),
          `<div class="wrap"><article class="card"><div class="pictures">${pictures}</div><div class="pictures is-one">${pictures}</div></article></div>`,
        ],
      ]) {
        await page.setContent(
          `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>${body}`,
        );
        await page.locator('img').evaluateAll(async (images) => {
          await Promise.all(images.map((img) => img.decode()));
        });
        const measurements = await page.locator('img').evaluateAll((images) =>
          images.map((img) => {
            const box = img.getBoundingClientRect();
            return {
              width: box.width,
              height: box.height,
              ratio: img.naturalWidth / img.naturalHeight,
              fit: getComputedStyle(img).objectFit,
              right: box.right,
            };
          }),
        );
        for (const [index, box] of measurements.entries()) {
          const label = `${name}/${width}/${colorScheme}/图片${index}`;
          assert.ok(box.width > 0 && box.height > 0, `${label} 未显示`);
          assert.ok(
            Math.abs(box.width / box.height / box.ratio - 1) < 0.01,
            `${label} 比例改变：${JSON.stringify(box)}`,
          );
          assert.notEqual(box.fit, 'cover', `${label} 被裁切`);
          assert.ok(box.right <= width, `${label} 超出页面`);
        }
        if (output)
          await page.screenshot({
            path: resolve(output, `${name}-${width}-${colorScheme}.png`),
            fullPage: true,
          });
      }
    }
  }
  console.log(
    'HTML 图片比例回归通过：聊天、说明文字、表情、转发、Markdown、空间单图/多图，桌面/窄屏与深浅色。',
  );
} finally {
  await browser?.close();
}
