// @vitest-environment node
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createImageProcessor } from '../src/main/image_processor';
import type { CardSpec } from '../src/main/weq_assistant/cover';

let root: string;
let processor: ReturnType<typeof createImageProcessor<{ operation: string; spec: CardSpec }>>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'weq-cover-worker-'));
  const resources = join(root, 'resources');
  const main = join(resources, 'out/main');
  const packages = join(resources, 'app.asar.unpacked/node_modules/@resvg');
  await mkdir(main, { recursive: true });
  await mkdir(packages, { recursive: true });
  await writeFile(join(resources, 'app.asar'), 'synthetic-asar-marker');
  await symlink(
    await realpath(resolve(__dirname, '../node_modules/@resvg/resvg-js')),
    join(packages, 'resvg-js'),
    'dir',
  );
  await symlink(resolve(__dirname, '../../../resources'), join(resources, 'resources'), 'dir');
  const path = join(main, 'coverWorker.mjs');
  await build({
    entryPoints: [resolve(__dirname, '../src/main/cover_worker.ts')],
    outfile: path,
    platform: 'node',
    format: 'esm',
    bundle: true,
  });
  processor = createImageProcessor({ workerPath: path, timeoutMs: 20_000 });
}, 20_000);

afterAll(async () => {
  processor?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it('独立封面进程在解包目录完成中文 PNG，父进程在渲染完成前继续处理事件', async () => {
  const pending = processor.run({
    operation: 'cover',
    spec: { title: '合成封面', theme: { mode: 'dark', accent: '#00a389' } },
  });
  expect(
    await Promise.race([
      pending.then(() => 'png'),
      new Promise((resolve) => setImmediate(() => resolve('tick'))),
    ]),
  ).toBe('tick');
  const png = (await pending) as Buffer;
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBe(1440);
  expect(png.readUInt32BE(20)).toBe(720);
  await expect(processor.run({ operation: 'unsupported', spec: { title: 'x' } })).rejects.toThrow(
    '不支持',
  );
  expect(
    Buffer.isBuffer(await processor.run({ operation: 'cover', spec: { title: '再次渲染' } })),
  ).toBe(true);
}, 20_000);
