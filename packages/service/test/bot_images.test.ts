import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { normalizeInbound } from '../../bot/src/normalize/inbound';
import { buildBotExport } from '../src/account/agentlab_export';
import { makeBackupPersona } from './fixtures/backup_persona';
import type { BotConfig, startBot } from '../../bot/src/index';
import { buildBotRuntime } from '../../../scripts/build-bot.mjs';

it.each(['private', 'group'] as const)(
  'OneBot %s 图片保留 URL 与文件标识，和原消息关联',
  (type) => {
    const result = normalizeInbound(
      {
        post_type: 'message',
        message_type: type,
        user_id: 10001,
        group_id: 20001,
        message_id: 10,
        message: [
          { type: 'text', data: { text: '看图' } },
          {
            type: 'image',
            data: { file: 'image_id_123', url: 'https://synthetic.invalid/image.png' },
          },
        ],
      },
      '10000',
    );
    expect(result).toMatchObject({
      text: '看图[图片]',
      images: [{ id: '10:0', file: 'image_id_123', url: 'https://synthetic.invalid/image.png' }],
    });
  },
);

it('导出 Bot 脱离桌面独立收图并回复，过期 URL 通过 get_image 回退，不要求 OCR 原生依赖', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-bot-image-export-'));
  const apiCalls: unknown[] = [];
  const actions: string[] = [];
  const sent: string[] = [];
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    'base64',
  );
  const http = createServer((req, res) => {
    if (req.url === '/image') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (part) => {
      body += String(part);
    });
    req.on('end', () => {
      apiCalls.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '合成看图回复' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  await new Promise<void>((ready) => http.listen(0, '127.0.0.1', ready));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((ready) => ws.once('listening', ready));
  const socketAddress = ws.address();
  if (typeof socketAddress === 'string') throw new Error('test socket unavailable');
  ws.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = JSON.parse(String(raw)) as {
        action: string;
        echo: unknown;
        params?: { message?: unknown; file?: unknown };
      };
      actions.push(request.action);
      if (request.action === 'get_image') expect(request.params?.file).toBe('image_id_123');
      if (request.action.startsWith('send_')) sent.push(JSON.stringify(request.params));
      socket.send(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          echo: request.echo,
          data:
            request.action === 'get_image'
              ? { file: '/remote-host/not-shared.png', url: `${baseUrl}/image` }
              : { message_id: 11 },
        }),
      );
    });
    socket.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        user_id: 10001,
        message_id: 10,
        message: [{ type: 'image', data: { file: 'image_id_123', url: `${baseUrl}/expired` } }],
      }),
    );
  });
  let bot: Awaited<ReturnType<typeof startBot>> | undefined;
  try {
    const persona = makeBackupPersona();
    const model = { providerId: 'synthetic-provider', model: 'synthetic-model' };
    const outDir = join(root, 'export');
    await buildBotRuntime(join(root, 'runtime'));
    const runtime = join(root, 'runtime', 'bot.mjs');
    await buildBotExport({
      outDir,
      botRuntimeMjs: runtime,
      persona,
      pairs: [],
      agentlabRoot: root,
      llmProviders: [{ id: model.providerId, baseUrl, apiKey: 'fixture' }],
      ttsProviders: [],
      adapter: { type: 'napcat', wsUrl: `ws://127.0.0.1:${socketAddress.port}` },
      selfId: '10000',
      features: { voice: false, groupChat: false },
      images: { mode: 'vision', visionModel: model, prefilterEnabled: false },
    });
    expect(existsSync(join(outDir, 'ocrWorker.mjs'))).toBe(true);
    expect(readFileSync(join(outDir, '.npmrc'), 'utf8')).toBe('onnxruntime-node-install=skip\n');
    const config = JSON.parse(readFileSync(join(outDir, 'config.json'), 'utf8')) as BotConfig;
    expect(config.images).toEqual({ mode: 'vision', visionModel: model, prefilterEnabled: false });
    config.personaDir = join(outDir, 'persona');
    config.webui!.enabled = false;
    const exported = (await import(pathToFileURL(join(outDir, 'bot.mjs')).href)) as {
      startBot: typeof startBot;
    };
    bot = await exported.startBot(config);
    await vi.waitFor(() => expect(sent.join('')).toContain('合成看图回复'), { timeout: 8000 });
    expect(actions).toContain('get_image');
    expect(apiCalls).toHaveLength(1);
    expect(JSON.stringify(apiCalls[0])).toContain('image_url');
    const history = readFileSync(join(outDir, 'data/conversations.json'), 'utf8');
    expect(history).not.toContain('base64');
    expect(history).toContain('images');
  } finally {
    await bot?.stop();
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((ready) => ws.close(() => ready()));
    http.closeAllConnections();
    await new Promise<void>((ready) => http.close(() => ready()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
