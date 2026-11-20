import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_NUMBER_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-profile-identity'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/profile-identity.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180])
    for (const theme of ['light', 'dark'])
      for (const embedded of [false, true])
        for (const kind of ['friend', 'group']) {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
          const params = new URLSearchParams({ short: '', 'number-fonts': '' });
          if (!embedded) params.set('popover', '');
          if (kind === 'friend') params.set('friend', '');
          await page.goto(
            `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-identity.html?${params}`,
          );
          await page
            .getByRole('button', { name: kind === 'friend' ? '复制 QQ' : '复制 群号', exact: true })
            .waitFor();
          await page.evaluate((theme) => {
            const store = window.profileIdentityQa.store.getState();
            store.setPreference(theme);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setBackground(theme === 'light' ? 'plain' : 'grid');
          }, theme);
          const values = await page
            .locator('.weq-contact-identity-body .weq-number')
            .evaluateAll((elements) =>
              elements.map((element) => {
                const style = getComputedStyle(element);
                const label = element
                  .closest('.weq-profile-data-row')
                  .querySelector('.weq-profile-data-label');
                const labelStyle = getComputedStyle(label);
                const button = element.querySelector('button');
                return {
                  text: element.textContent,
                  family: style.fontFamily,
                  labelFamily: labelStyle.fontFamily,
                  size: style.fontSize,
                  labelSize: labelStyle.fontSize,
                  weight: style.fontWeight,
                  numeric: style.fontVariantNumeric,
                  buttonFamily: button ? getComputedStyle(button).fontFamily : null,
                };
              }),
            );
          const label = `${width}-${theme}-${embedded ? 'page' : 'card'}-${kind}`;
          assert.deepEqual(
            values.map((value) => value.text),
            kind === 'friend'
              ? ['10001', 'fixture-qid', 'u_Fixture0Il1_identifier_for_font_check']
              : ['20001'],
            label,
          );
          for (const value of values) {
            assert.equal(value.family, value.labelFamily, label);
            assert.equal(value.size, value.labelSize, label);
            assert.equal(value.weight, '500', label);
            assert.equal(value.numeric, 'tabular-nums', label);
            assert.equal(value.buttonFamily, value.family, `${label}: 复制按钮覆盖字体`);
          }
          assert.equal(
            await page
              .locator('.weq-profile-data-label.weq-number, .weq-profile-name.weq-number')
              .count(),
            0,
            label,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
            label,
          );
          assert.equal(
            await page
              .locator('.weq-contact-identity-body')
              .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
            false,
            label,
          );
          if (output && [390, 1180].includes(width))
            await page.screenshot({ path: resolve(output, `${label}.png`) });
          cases++;
        }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
