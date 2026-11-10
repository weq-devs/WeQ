import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Sharp from 'sharp';
import type { ImageReply, ImageRequest } from './image_worker_protocol';
import { PREVIEW_MAX_SIDE } from './image_worker_protocol';

// Node 子进程不解析 asar，复用现有解包依赖，不另复制 sharp / @img。
const resources = join(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(
  existsSync(join(resources, 'app.asar'))
    ? join(resources, 'app.asar.unpacked/node_modules/sharp/package.json')
    : import.meta.url,
);
const sharp: typeof Sharp = require('sharp');
sharp.concurrency(1);

async function run(request: ImageRequest & { id: number }): Promise<void> {
  let reply: ImageReply;
  try {
    const input = typeof request.input === 'string' ? request.input : Buffer.from(request.input);
    const image = sharp(input, {
      limitInputPixels: request.maxPixels,
      sequentialRead: true,
      animated: false,
    });
    if (request.operation === 'metadata') {
      const { width, height, pageHeight, pages } = await image.metadata();
      reply = { id: request.id, result: { width, height, pageHeight, pages } };
    } else {
      if (request.preserveAnimation && ((await image.metadata()).pages ?? 1) > 1)
        throw new Error('animated preview');
      const result = await image
        .rotate()
        .resize({
          width: PREVIEW_MAX_SIDE,
          height: PREVIEW_MAX_SIDE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer();
      reply = { id: request.id, result };
    }
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  if (process.connected)
    process.send?.(reply, (error) => {
      if (error) process.exit(1);
    });
}

// 多个预览器共用单一原生解码队列；主进程断开时不遗留后台进程。
let queue = Promise.resolve();
process.on('message', (request: ImageRequest & { id: number }) => {
  queue = queue.then(() => run(request));
});
process.once('disconnect', () => process.exit(0));
