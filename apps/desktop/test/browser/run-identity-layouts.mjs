import assert from 'node:assert/strict';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(root, '../../node_modules/.cache/identity-links-qa');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WEQ_BROWSER_EXECUTABLE
    ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
    : {}),
});
const failures = [];
let cases = 0;
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.route('**/*', (route) => route.abort());
  await mkdir(resolve(directory, 'shots'), { recursive: true });
  for (const file of (await readdir(directory)).filter((file) => file.endsWith('.html'))) {
    for (const width of [320, 1180])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.setContent(await readFile(resolve(directory, file), 'utf8'));
        await page.addStyleTag({
          content: '*,*::before,*::after{animation:none!important;transition:none!important}',
        });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'dark' ? '#e08aa0' : '#287b53',
          );
          // 单测快照保留了当时的浮窗坐标；这里只检查窗内身份区，不复测浮窗定位。
          const floating = document.querySelector('.weq-forward-window');
          if (floating)
            Object.assign(floating.style, {
              position: 'static',
              left: 'auto',
              top: 'auto',
              width: '100%',
              maxWidth: '100%',
              transform: 'none',
            });
        }, theme);
        const layout = await page.evaluate(() => {
          const identities = [
            ...document.querySelectorAll('.weq-identity-link, .weq-number-lookup-identity'),
          ];
          return identities.map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              text: node.textContent.trim(),
              left: rect.left,
              right: rect.right,
              overflow: node.scrollWidth > node.clientWidth + 2,
              nestedButton: Boolean(node.querySelector('button')),
            };
          });
        });
        for (const identity of layout)
          if (
            identity.nestedButton ||
            identity.overflow ||
            identity.left < -1 ||
            identity.right > width + 1
          )
            failures.push({ file, width, theme, identity });
        if (
          [
            'announcements.html',
            'forward.html',
            'redbag-group.html',
            'buddy-analysis.html',
            'number-results.html',
            'collection-detail.html',
          ].includes(file)
        )
          await page.screenshot({
            path: resolve(directory, 'shots', `${file}-${width}-${theme}.png`),
            fullPage: true,
          });
        cases++;
      }
  }
  console.log(JSON.stringify({ cases, failures }));
  assert.deepEqual(failures, []);
} finally {
  await browser.close();
}
