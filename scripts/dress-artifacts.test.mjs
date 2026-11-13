import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  checkDressManifest,
  includeSharedResource,
  validateDressManifest,
  verifyPackagedDressResources,
} from './dress-artifacts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('已固定的装扮索引与 native commit 来源一致', () => {
  const manifest = checkDressManifest(root);
  assert.equal(manifest.format, 'ntdr-v1');
  assert.throws(() => validateDressManifest(manifest, { commit: '0'.repeat(40) }), /密钥来源不同/);
  assert.throws(() => validateDressManifest({ ...manifest, baseUrl: 'http://example.com' }));
  assert.throws(() =>
    validateDressManifest({ ...manifest, parts: { bubble: manifest.parts.bubble } }),
  );
  assert.throws(() =>
    validateDressManifest({
      ...manifest,
      parts: { ...manifest.parts, font: { ...manifest.parts.font, asset: '../font.dat' } },
    }),
  );
});

test('资源复制保留索引清单、排名及界面素材，不携带大索引或采集状态', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'dress-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'source');
  const output = join(temporary, 'output');
  const files = [
    'dress/font.dat',
    'dress/bubble.dat',
    'dress/widget.dat',
    'dress/font_resources',
    'dress/fetch-state.json',
    'dress/ranking-font.json',
    'dress/screen/1/config.json',
    'brand/logo.png',
    'daemon/old-binary',
  ];
  for (const file of files) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await writeFile(join(source, file), 'fixture');
  }
  await writeFile(
    join(source, 'dress/index-manifest.json'),
    await readFile(join(root, 'resources/dress/index-manifest.json')),
  );
  await cp(source, output, {
    recursive: true,
    filter: (path) => includeSharedResource(path, source),
  });
  verifyPackagedDressResources(output);
  assert.deepEqual((await readdir(join(output, 'dress'))).sort(), [
    'index-manifest.json',
    'ranking-font.json',
    'screen',
  ]);
  assert.equal(await readFile(join(output, 'dress/screen/1/config.json'), 'utf8'), 'fixture');
  await writeFile(join(output, 'dress/bubble.dat'), 'unexpected');
  assert.throws(() => verifyPackagedDressResources(output), /不应包含/);
});

test('桌面打包明确排除三类大索引，Web 复用经过行为测试的复制筛选', async () => {
  const desktop = await readFile(join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
  for (const pattern of ['!dress/*.dat', '!dress/*_resources', '!dress/fetch-state.json'])
    assert(desktop.includes(pattern));
  const web = await readFile(join(root, 'apps/web/scripts/build-server.mjs'), 'utf8');
  assert(web.includes('includeSharedResource(source, RESOURCES_SRC)'));
  assert(web.includes("verifyPackagedDressResources(join(dist, 'resources'))"));
});
