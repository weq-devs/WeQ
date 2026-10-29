// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { OneBotServer, type BridgeMessage } from '../src/main/onebot/server';

it.skipIf(!process.env.WEQ_CC_CONNECT_SOURCE)(
  'actual cc-connect QQ adapter consumes WeQ events and replies with text, images and files',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weq-onebot-probe-'));
    const image = join(directory, 'image.png');
    const file = join(directory, 'test.txt');
    await writeFile(
      image,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    await writeFile(file, 'synthetic file');
    let deliver: (msg: BridgeMessage) => void = () => {};
    const sends: unknown[] = [];
    const server = new OneBotServer(
      {
        status: () => ({ online: true, good: true }),
        self: async () => ({ user_id: 99, nickname: 'Synthetic' }),
        group: async () => ({ group_id: 42, group_name: 'Synthetic group' }),
        typing: async () => {},
        subscribe(handler) {
          deliver = handler;
          return () => {};
        },
        async send(target, segments, reply) {
          sends.push({ target, segments, reply });
          return {
            ...target,
            key: `sent:${sends.length}`,
            sequence: 92,
            senderUin: 99,
            nickname: '',
            time: Math.floor(Date.now() / 1000),
            message: segments,
          };
        },
      },
      'synthetic-token',
    );
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const port = await server.start(0);
      child = spawn(
        'go',
        [
          'run',
          fileURLToPath(new URL('./fixtures/onebot_cc_connect_probe.go', import.meta.url)),
          `ws://127.0.0.1:${port}`,
        ],
        {
          cwd: process.env.WEQ_CC_CONNECT_SOURCE,
          env: { ...process.env, GOPROXY: 'off', GOSUMDB: 'off' },
        },
      );
      let output = '';
      let error = '';
      let sent = false;
      child.stdout!.on('data', (data) => {
        output += String(data);
        if (!sent && output.includes('READY')) {
          sent = true;
          deliver({
            key: 'group:42:9007199254740993123',
            peerType: 'group',
            targetId: '42',
            sequence: 91,
            senderUin: 7,
            nickname: 'Synthetic peer',
            time: Math.floor(Date.now() / 1000),
            message: [
              { type: 'at', data: { qq: '99' } },
              { type: 'text', data: { text: 'hello' } },
              { type: 'image', data: { file: 'image.png', url: server.mediaUrl(image) } },
              {
                type: 'file',
                data: { file: 'test.txt', name: 'test.txt', url: server.mediaUrl(file) },
              },
            ],
          });
        }
      });
      child.stderr!.on('data', (data) => {
        error += String(data);
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child!.on('error', reject);
        child!.on('close', resolve);
      });
      expect(exit, error).toBe(0);
      expect(output).toContain('PASS');
      expect(sends).toMatchObject([
        {
          target: { peerType: 'group', targetId: '42' },
          segments: [{ type: 'text', data: { text: 'response' } }],
          reply: { sequence: 91 },
        },
        {
          segments: [{ type: 'image', data: { file: expect.stringMatching(/^base64:\/\//) } }],
          reply: { sequence: 91 },
        },
        {
          segments: [
            {
              type: 'file',
              data: { file: expect.stringMatching(/^base64:\/\//), name: 'test.txt' },
            },
          ],
        },
      ]);
    } finally {
      child?.kill('SIGTERM');
      server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
