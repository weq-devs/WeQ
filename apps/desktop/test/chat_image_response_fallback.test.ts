// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { chatImageResponse } from '../src/main/chat_image_response';
import { imageProcessor } from '../src/main/image_processor';
import * as workerPath from '../src/main/worker_path';

// 模拟 Linux/Electron 上 sharp 原生库一加载就崩溃：worker 收到请求立刻非零退出。
// 这里用普通退出而不是真发 SIGSEGV，避免测试环境产生 core dump；对上层而言两者
// 都走 image_processor 的「不可用」判定。
let root: string;
let crashWorker: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'weq-chat-preview-fallback-'));
  crashWorker = join(root, 'crashWorker.mjs');
  await writeFile(crashWorker, "process.on('message', () => process.exit(1));\n");
});

afterAll(async () => {
  imageProcessor.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('原生解码进程不可用时，气泡回退为可直接展示的本机图片', async () => {
  vi.spyOn(workerPath, 'resolveChildWorkerPath').mockReturnValue(crashWorker);
  const path = join(root, 'photo.png');
  const input = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  await writeFile(path, input);

  const response = await chatImageResponse(path);
  expect(imageProcessor.isUnavailable()).toBe(true);
  expect(response.headers.get('Content-Type')).toBe('image/png');
  expect(response.headers.get('Cache-Control')).toBe('no-cache');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(input);
});

it('不可用时坏文件仍回退占位图，不把任意字节当图片', async () => {
  const broken = join(root, 'broken.png');
  await writeFile(broken, 'not an image');

  const response = await chatImageResponse(broken);
  expect(response.headers.get('Content-Type')).toContain('image/svg+xml');
  expect(await response.text()).toContain('点击查看原图');
});
