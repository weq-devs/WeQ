// @vitest-environment node
import { build } from 'esbuild';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createImageProcessor } from '../src/main/image_processor';
import { buildImageWorker } from './support/image-worker';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'weq-image-isolation-'));
});
afterAll(async () => rm(root, { recursive: true, force: true }));

it('主进程图片入口的依赖闭包不加载 sharp 或 QQ 原生模块', async () => {
  const result = await build({
    entryPoints: [
      resolve(__dirname, '../src/main/image_preview.ts'),
      resolve(__dirname, '../src/main/chat_image_response.ts'),
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outdir: join(root, 'main'),
    write: false,
    metafile: true,
  });
  const imports = Object.values(result.metafile!.outputs).flatMap((output) =>
    output.imports.map((entry) => entry.path),
  );
  expect(imports).not.toContain('sharp');
  expect(imports).not.toContain('@weq/native');
});

it('实体 worker 从 asar 解包目录加载 sharp 并返回真实图片结果', async () => {
  const resources = join(root, 'Resources');
  const main = join(resources, 'out/main');
  await mkdir(main, { recursive: true });
  const path = await buildImageWorker(main);
  // 移除通用 node_modules 回退，强制走安装包的实体解包路径。
  await rm(join(main, 'node_modules'));
  await writeFile(join(resources, 'app.asar'), 'fixture');
  await mkdir(join(resources, 'app.asar.unpacked/node_modules'), { recursive: true });
  await symlink(
    resolve(__dirname, '../node_modules/sharp'),
    join(resources, 'app.asar.unpacked/node_modules/sharp'),
    'dir',
  );
  const processor = createImageProcessor({ workerPath: path });
  const input = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  try {
    await expect(
      processor.run({ operation: 'metadata', input: Buffer.from('broken image'), maxPixels: 100 }),
    ).rejects.toThrow();
    expect(await processor.run({ operation: 'metadata', input, maxPixels: 100 })).toMatchObject({
      width: 1,
      height: 1,
    });
    expect(
      await processor.run({ operation: 'preview', input, maxPixels: 100, preserveAnimation: true }),
    ).toBeInstanceOf(Buffer);
  } finally {
    processor.close();
  }
});

it('复用进程，失败不污染后续请求；崩溃、超时及空闲退出后可重新启动', async () => {
  const path = join(root, 'lifecycle.mjs');
  await writeFile(
    path,
    `
process.on('message', (request) => {
  if (request.input === 'crash') process.exit(2);
  else if (request.input !== 'hang') process.send({ id: request.id, result: { width: process.pid } });
});
process.once('disconnect', () => process.exit(0));
`,
  );
  const processor = createImageProcessor({ workerPath: path, timeoutMs: 2000, idleMs: 100 });
  const run = (input = 'ok') => processor.run({ operation: 'metadata', input, maxPixels: 100 });
  try {
    const first = await run();
    expect(await run()).toEqual(first);
    const crashed = run('crash');
    const queued = run('hang');
    await Promise.all([
      expect(crashed).rejects.toThrow('图片处理进程'),
      expect(queued).rejects.toThrow('图片处理进程'),
    ]);
    expect(await run()).not.toEqual(first);
    await expect(run('hang')).rejects.toThrow('图片处理超时');
    const restarted = await run();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await run()).not.toEqual(restarted);
  } finally {
    processor.close();
  }
}, 10_000);

it('在途请求有容量上限，关闭时全部结算', async () => {
  const path = join(root, 'capacity.mjs');
  await writeFile(
    path,
    "process.on('message', () => {}); process.once('disconnect', () => process.exit(0));",
  );
  const processor = createImageProcessor({ workerPath: path });
  const results = Array.from({ length: 128 }, () =>
    processor
      .run({ operation: 'metadata', input: 'hang', maxPixels: 100 })
      .catch((error: Error) => error.message),
  );
  try {
    await expect(
      processor.run({ operation: 'metadata', input: 'overflow', maxPixels: 100 }),
    ).rejects.toThrow('preview capacity');
  } finally {
    processor.close();
  }
  expect(await Promise.all(results)).toEqual(Array(128).fill('图片处理进程已关闭'));
});

it('父进程自然退出后图片 worker 不留在后台', async () => {
  const dir = join(root, 'parent');
  await mkdir(dir);
  await buildImageWorker(dir);
  const parent = join(dir, 'parent.mjs');
  await build({
    stdin: {
      contents: `import { imageMetadata } from ${JSON.stringify(resolve(__dirname, '../src/main/image_processor.ts'))};
await imageMetadata(Buffer.from('not an image'), 100).catch(() => {});`,
      resolveDir: __dirname,
    },
    outfile: parent,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  const child = fork(parent, [], {
    execArgv: [],
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  try {
    expect(
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('父进程未自然退出')), 3000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      }),
    ).toBe(0);
  } finally {
    child.kill();
  }
});
