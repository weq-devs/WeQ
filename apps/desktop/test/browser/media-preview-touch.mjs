import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import sharp from 'sharp';

export async function runMediaPreviewTouch(page, output) {
  // Chromium 平台多点触摸会产生真实 Pointer Events、隐式捕获及兼容鼠标事件。
  const input = await page.context().newCDPSession(page);
  const touch = (type, points = []) =>
    input.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([id, x, y]) => ({ id, x, y })),
    });
  const scale = () =>
    page.locator('.weq-lightbox-frame').evaluate((el) => {
      const transform = new DOMMatrix(getComputedStyle(el).transform);
      return transform.a;
    });
  const swipe = async (x, y, dx, dy = 0) => {
    await touch('touchStart', [[1, x, y]]);
    await touch('touchMove', [[1, x + dx, y + dy]]);
    await touch('touchEnd');
  };
  let touchCases = 0;
  for (const size of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => window.mediaTheme.getState().setPreference(value), theme);
      await page.getByRole('button', { name: '打开触摸图库', exact: true }).click();
      await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
      const image = page.locator('.weq-lightbox-frame');
      await image.evaluate((el) => {
        window.previewPointerIds = [];
        el.addEventListener('pointerdown', (event) =>
          window.previewPointerIds.push(event.pointerId),
        );
      });
      const bounds = await image.boundingBox();
      const x = bounds.x + bounds.width / 2,
        y = bounds.y + bounds.height / 2;
      await touch('touchStart', [[1, x - 40, y]]);
      await touch('touchStart', [
        [1, x - 40, y],
        [2, x + 40, y],
      ]);
      assert.equal(
        await image.evaluate(
          (el) =>
            window.previewPointerIds.length === 2 &&
            window.previewPointerIds.every((id) => el.hasPointerCapture(id)),
        ),
        true,
      );
      await touch('touchMove', [
        [1, x - 80, y + 10],
        [2, x + 80, y + 10],
      ]);
      assert.ok(Math.abs((await scale()) - 2) < 0.01);
      assert.equal(await image.evaluate((el) => getComputedStyle(el).transitionDuration), '0s');
      const enlarged = await image.boundingBox();
      assert.ok(Math.abs(enlarged.width / bounds.width - 2) < 0.01);
      assert.equal(await page.evaluate(() => visualViewport.scale), 1);
      if (output)
        await page.screenshot({ path: resolve(output, `${theme}-${size.width}-pinch.png`) });
      await touch('touchEnd', [[2, x + 80, y + 10]]);
      await touch('touchMove', [[2, x + 100, y + 20]]);
      await touch('touchEnd');
      assert.ok(Math.abs((await scale()) - 2) < 0.01);
      assert.equal(await page.locator('.weq-preview-count').textContent(), '1 / 3');
      await swipe(x, y, -90);
      assert.equal(await page.locator('.weq-preview-count').textContent(), '1 / 3');
      await page.getByRole('button', { name: '适应窗口', exact: true }).click();
      await touch('touchStart', [[1, x - 60, y]]);
      await touch('touchStart', [
        [1, x - 60, y],
        [2, x + 60, y],
      ]);
      await touch('touchMove', [
        [1, x - 30, y],
        [2, x + 30, y],
      ]);
      await touch('touchEnd');
      assert.equal(await scale(), 1);
      assert.equal(
        await page.getByRole('button', { name: '缩小', exact: true }).isDisabled(),
        true,
      );
      await swipe(x, y, -90);
      await page.waitForFunction(
        () => document.querySelector('.weq-preview-count')?.textContent === '2 / 3',
      );
      assert.equal(await scale(), 1);
      // 图片外空白也可横滑；页头/底栏操作不属于图片手势区域。
      const viewport = await page.locator('.weq-preview-viewport').boundingBox();
      await swipe(12, viewport.y + 20, 90);
      await page.waitForFunction(
        () => document.querySelector('.weq-preview-count')?.textContent === '1 / 3',
      );
      await swipe(x, y, 12);
      await swipe(x, y, 60, 100);
      assert.equal(await scale(), 1);
      assert.equal(await page.locator('.weq-preview-count').textContent(), '1 / 3');
      await touch('touchStart', [[1, x - 40, y]]);
      await touch('touchStart', [
        [1, x - 40, y],
        [2, x + 40, y],
      ]);
      await touch('touchCancel');
      await swipe(x, y, -90);
      await page.waitForFunction(
        () => document.querySelector('.weq-preview-count')?.textContent === '2 / 3',
      );
      const pixels = await sharp(await page.locator('.weq-lightbox-image').screenshot()).stats();
      assert.ok(pixels.channels[1].mean > 80);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      touchCases++;
    }
  }
  await input.detach();
  return touchCases;
}
