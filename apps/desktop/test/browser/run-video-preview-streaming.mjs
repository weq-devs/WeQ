import assert from 'node:assert/strict';

const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WEQ_BROWSER_EXECUTABLE
    ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage();
  await page.goto(process.argv[2]);
  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.src = '/_media/video?token=progressive.webm&msgId=1&conv=123';
    void video.play();
  });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0);
  for (const src of [
    '/_media/video?token=tail.mp4&msgId=2&conv=123',
    '/_media/file?token=clip.mov&name=clip.mov&msgId=3&conv=123',
  ]) {
    await page.evaluate(async (source) => {
      const video = document.querySelector('video');
      video.pause();
      video.src = source;
      await video.play();
      video.currentTime = 9;
    }, src);
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return !video.seeking && video.currentTime >= 9 && video.readyState >= 2;
    });
    const width = await page.locator('video').evaluate((video) => video.videoWidth);
    assert.equal(width, 320);
  }
  console.log(JSON.stringify({ played: true, sought: true, movSought: true }));
} finally {
  await browser.close();
}
