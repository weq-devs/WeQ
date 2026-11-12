import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { load } = libraryRequire('js-yaml');

test('Windows 发布先强制获取同步组件，打包从独立原生产物目录取用', () => {
  const release = load(
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );
  const steps = release.jobs.windows.steps;
  const fetch = steps.findIndex((step) => step.run?.includes('fetch-native.mjs'));
  const build = steps.findIndex(
    (step) => step.run === 'pnpm --filter @weq/desktop exec electron-vite build',
  );
  assert.ok(fetch >= 0 && fetch < build);
  assert.match(steps[fetch].run, /--require-qq-sync\b/);
  const builder = load(
    readFileSync(new URL('../apps/desktop/electron-builder.yml', import.meta.url), 'utf8'),
  );
  assert.equal(builder.beforePack, '../../scripts/package-qq-sync.mjs');
  assert.ok(
    builder.win.extraResources.some(
      (entry) => entry.from === '../../native/qq-sync' && entry.to === 'qq-sync',
    ),
  );
});
