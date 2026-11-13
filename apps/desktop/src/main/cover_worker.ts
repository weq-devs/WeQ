import { renderCardPngInWorker } from './weq_assistant/cover_renderer';
import type { CardRenderRequest } from './weq_assistant/cover';
import type { ImageReply } from './image_worker_protocol';

async function run(request: CardRenderRequest & { id: number }): Promise<void> {
  let reply: ImageReply;
  try {
    if (request.operation !== 'cover') throw new Error('不支持的封面处理操作');
    reply = { id: request.id, result: await renderCardPngInWorker(request.spec) };
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  if (process.connected)
    process.send?.(reply, (error) => {
      if (error) process.exit(1);
    });
}

let queue = Promise.resolve();
process.on('message', (request: CardRenderRequest & { id: number }) => {
  queue = queue.then(() => run(request));
});
process.once('disconnect', () => process.exit(0));
