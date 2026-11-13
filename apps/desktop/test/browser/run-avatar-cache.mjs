import assert from 'node:assert/strict';

const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const [, , base, avatar] = process.argv;
assert.equal(new URL(base).hostname, '127.0.0.1');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WEQ_BROWSER_EXECUTABLE
    ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage();
  // 不使用 route 拦截：Playwright 拦截会禁用 HTTP 缓存，无法验证真实复用。
  await page.goto(base);
  const reads = await page.evaluate(async (url) => {
    const values = [];
    for (let i = 0; i < 12; i++) values.push(await (await fetch(url)).text());
    return values;
  }, avatar);
  await page.reload();
  reads.push(await page.evaluate(async (url) => (await fetch(url)).text(), avatar));
  assert.ok(reads.every((value) => value === 'synthetic-avatar'));
  const refreshed = await page.evaluate(async (url) => {
    const response = await fetch(`${url}&_weq_avatar_refresh=1`);
    return response.ok && (await response.text()) === 'synthetic-avatar';
  }, avatar);
  assert.ok(refreshed);
  console.log(JSON.stringify({ reads: reads.length, refreshed }));
} finally {
  await browser.close();
}
