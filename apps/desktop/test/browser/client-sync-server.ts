import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { clientStateRouter } from '../../src/main/ipc/routers/client_state';
import { procedure, router } from './client-sync-trpc';
import { requireBootstrap } from './client-sync-context';
const appRouter = router({
  clientState: clientStateRouter,
  bootstrap: router({
    getSettings: procedure.query(() => requireBootstrap().userConfig.getSettings()),
    setRenderTextMarkdown: procedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(({ input }) =>
        requireBootstrap().userConfig.setSettings({ renderTextMarkdown: input.enabled }),
      ),
    setAutoFollowLatestMessages: procedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(({ input }) =>
        requireBootstrap().userConfig.setSettings({ autoFollowLatestMessages: input.enabled }),
      ),
    setChatImageCacheMiB: procedure
      .input(z.object({ miB: z.number().int().min(0) }))
      .mutation(({ input }) =>
        requireBootstrap().userConfig.setSettings({ chatImageCacheMiB: input.miB }),
      ),
  }),
  account: router({
    getAccountConfig: procedure.query(() => ({ uin: '10001', configId: '10001_fixture' })),
  }),
});
const handler = createHTTPHandler({
  router: appRouter,
  createContext: ({ req }) => ({ host: req.headers['x-fixture-desktop'] ? undefined : {} }),
});
const server = createServer((req, res) => {
  req.url = req.url?.replace(/^\/trpc/, '') || '/';
  void handler(req, res);
});
const wss = new WebSocketServer({ server });
applyWSSHandler({ wss, router: appRouter, createContext: () => ({ host: {} }) });
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(JSON.stringify({ port: address.port }));
});
process.on('SIGTERM', () => {
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close(() => process.exit());
});
