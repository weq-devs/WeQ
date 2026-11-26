// @vitest-environment node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect, it, vi } from 'vitest';
import { startMcpServer, stopMcpServer } from '../src/main/mcp/server';

const fake = vi.hoisted(() => ({
  services: null as object | null,
  account: { context: { uin: '10001' } },
  bootstrap: { userConfig: { getSettings: () => ({ autoAttachQq: true }) } },
  serve: vi.fn(),
  fetch: vi.fn(),
  transcribeSilk: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => fake }));
vi.mock('../src/main/media_protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/media_protocol')>()),
  handleMediaRequest: fake.serve,
}));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  getHost: () => ({ fetchMedia: fake.fetch }),
}));

afterEach(async () => {
  fake.services = null;
  vi.clearAllMocks();
  await stopMcpServer();
});

it('issues private and group video downloads only for the exact message and bound account', async () => {
  const video = (label: string) => ({
    type: 'video',
    data: { fileName: `${label}.mp4`, fileToken: `${label}-fixture-key`, fileSize: 4 },
  });
  const group = {
    targetGroupCode: '12345',
    sendTime: 123n,
    elements: [video('one'), { type: 'text' }, video('two')],
  };
  const direct = { targetUid: 'u_fixture', sendTime: 456n, elements: [video('direct')] };
  fake.services = {
    msgs: {
      // The raw lookups are by ID and can return a row from another conversation.
      getGroupMessageById: async () => group,
      getC2cMessageById: async () => direct,
    },
  };
  const port = await startMcpServer({ port: 0, token: 'synthetic-only' });
  const base = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'chat-video-fixture', version: '1' });
  const headers = { Authorization: 'Bearer synthetic-only' };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers } }),
  );
  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: 'download_chat_video', arguments: { msgId: '1001', ...args } });
  const downloadPath = async (target: Record<string, unknown>, fileName: string) => {
    const result = await call(target);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      fileName,
      downloadPath: expect.stringMatching(/^\/chat\/videos\//),
      expiresIn: 300,
      size: 4,
    });
    return new URL(String(result.structuredContent?.downloadPath), base);
  };
  try {
    expect((await call({ kind: 'group', conv: '12346' })).isError).toBe(true);
    expect((await call({ kind: 'c2c', conv: 'u_other' })).isError).toBe(true);
    expect((await call({ kind: 'group', conv: '12345', videoIndex: 2 })).isError).toBe(true);
    const groupUrl = await downloadPath({ kind: 'group', conv: '12345', videoIndex: 1 }, 'two.mp4');
    const directUrl = await downloadPath({ kind: 'c2c', conv: 'u_fixture' }, 'direct.mp4');
    expect((await fetch(groupUrl)).status).toBe(401);
    expect(fake.serve).not.toHaveBeenCalled();

    const bytes = Uint8Array.of(0, 1, 2, 255);
    fake.serve.mockResolvedValueOnce(
      new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }),
    );
    const response = await fetch(groupUrl, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('two.mp4');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const request = fake.serve.mock.calls[0]?.[0] as Request;
    const query = new URL(request.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      t: '123000',
      name: 'two.mp4',
      token: 'two-fixture-key',
      msgId: '1001',
      conv: '12345',
      intent: 'interactive',
    });

    fake.serve.mockResolvedValueOnce(new Response('upstream fixture', { status: 404 }));
    const unavailable = await fetch(directUrl, { headers });
    expect(unavailable.status).toBe(422);
    expect(await unavailable.text()).not.toContain('upstream fixture');
    expect(new URL(fake.serve.mock.calls[1]?.[0].url).searchParams.get('conv')).toBe('');
    fake.services = { ...fake.services };
    expect((await fetch(groupUrl, { headers })).status).toBe(404);
    expect(fake.serve).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
  }
});

it('downloads a verified directory file, the selected same-name chat attachment and playable voice', async () => {
  const file = (fileToken: string) => ({ fileToken, fileName: 'report.pdf', fileSize: 4 });
  const files = [file('first'), file('second')];
  const direct = {
    targetUid: 'u_fixture',
    sendTime: 456n,
    elements: [
      ...files.map((data) => ({ type: 'file', data })),
      { type: 'ptt', data: { fileToken: 'voice-id', fileName: 'clip.silk' } },
    ],
  };
  const resolveFileUrl = vi.fn(async () => 'https://synthetic.invalid/chat');
  const getGroupFileUrl = vi.fn(async () => 'https://synthetic.invalid/group');
  const getFileInfoByMsgId = vi.fn();
  const findFileInDirectory = vi.fn(async (_id: number, folderId: string, fileId: string) =>
    folderId === 'docs' && fileId === 'group-id' ? { ...file(''), fileId, busId: 7 } : undefined,
  );
  fake.services = {
    accountConfig: { getRecord: () => ({ configId: 'fixture', qqPid: 10, qqOnline: true }) },
    groupFile: { findFileInDirectory },
    msgs: {
      getC2cMessageById: async () => direct,
      getRawElements: async () => ({
        kind: 'c2c',
        elements: files.map((data) => ({ kind: 'file', ...data })),
      }),
    },
    fileResource: { resolveSentFile: async () => null },
    fileAssistant: { getFileInfoByMsgId },
    mediaUrl: { resolveFileUrl, getGroupFileUrl },
  };
  const bytes = Uint8Array.of(0, 1, 2, 255);
  fake.fetch.mockImplementation(async () => new Response(bytes));
  fake.serve.mockImplementation(async () => new Response(bytes));
  const port = await startMcpServer({ port: 0, token: 'synthetic-only' });
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: 'Bearer synthetic-only' };
  const client = new Client({ name: 'chat-file-fixture', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers } }),
    );
    const target = { kind: 'c2c', conv: 'u_fixture', msgId: '1001' };
    const group = { groupCode: '12345', folderId: 'docs', fileId: 'group-id' };
    const call = (name: string, args: Record<string, unknown>, compact = false) =>
      client.callTool({
        name: compact ? 'call_capability' : name,
        arguments: compact ? { name, arguments: args } : args,
      });
    expect((await call('download_chat_file', { ...target, conv: 'u_other' })).isError).toBe(true);
    expect((await call('download_group_file', { ...group, folderId: '/' })).isError).toBe(true);
    const download = async (result: Awaited<ReturnType<typeof call>>, fileName: string) => {
      expect(result.isError).toBeFalsy();
      const { downloadPath } = JSON.parse((result.content as { text: string }[])[0]!.text);
      const url = new URL(downloadPath, base);
      expect(url.pathname).toMatch(/^\/files\//);
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(fileName);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      return url;
    };
    const groupUrl = await download(await call('download_group_file', group, true), 'report.pdf');
    expect(getGroupFileUrl).toHaveBeenCalledWith(12345, 'group-id', 7, 'report.pdf');
    await download(await call('download_chat_file', { ...target, fileIndex: 1 }), 'report.pdf');
    expect(resolveFileUrl).toHaveBeenCalledWith(
      'c2c',
      0,
      expect.objectContaining({ fileToken: 'second' }),
      'report.pdf',
    );
    expect(getFileInfoByMsgId).not.toHaveBeenCalled();
    await download(await call('download_chat_voice', target), 'clip.wav');
    expect(new URL(fake.serve.mock.calls[0]?.[0].url).searchParams.get('token')).toBe('voice-id');
    fake.services = { ...fake.services };
    expect((await fetch(groupUrl, { headers })).status).toBe(404);
  } finally {
    await client.close();
  }
});

it('scopes online forward fallback and external voice transcription to the requested chat', async () => {
  const fetchForExport = vi.fn(async () => [
    {
      msgId: '2',
      senderUin: '10001',
      sendNick: 'Fixture',
      elements: [{ type: 'text', data: { textContent: 'remote forward' } }],
    },
  ]);
  fake.transcribeSilk.mockResolvedValue({ ok: true, text: 'fixture transcript' });
  fake.services = {
    accountConfig: { getRecord: () => ({ configId: 'fixture', qqPid: 10, qqOnline: true }) },
    msgs: {
      getGroupMessageById: async () => ({
        targetGroupCode: '12345',
        sendTime: 456n,
        elements: [
          { type: 'multiMsg', data: { resId: 'trusted-forward-id' } },
          { type: 'ptt', data: { fileName: 'clip.silk' } },
        ],
      }),
    },
    forwardMsgs: { getGroupForward: async () => [], fetchForExport },
    fileSearch: { findFile: async () => ({ source: '/synthetic/clip.silk' }) },
  };
  const port = await startMcpServer({ port: 0, token: 'synthetic-only' });
  const client = new Client({ name: 'chat-content-fixture', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}`), {
        requestInit: { headers: { Authorization: 'Bearer synthetic-only' } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({
        name,
        arguments: { kind: 'group', msgId: '1', ...args },
      });
      expect(result.isError).toBeFalsy();
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    };
    expect(await call('get_forward_messages', {})).toMatchObject({ found: false });
    expect(await call('get_forward_messages', { conv: '54321' })).toMatchObject({ found: false });
    expect(fetchForExport).not.toHaveBeenCalled();
    expect(await call('get_forward_messages', { conv: '12345' })).toMatchObject({
      found: true,
      source: 'online',
      messages: [{ mine: true, text: 'remote forward' }],
    });
    expect(fetchForExport).toHaveBeenCalledWith('trusted-forward-id');
    expect(await call('transcribe_voice_message', { conv: '54321' })).toMatchObject({
      found: false,
    });
    expect(fake.transcribeSilk).not.toHaveBeenCalled();
    const voice = await call('transcribe_voice_message', { conv: '12345' });
    expect(voice).toMatchObject({ ok: true, results: [{ transcript: 'fixture transcript' }] });
    expect(voice.results[0]).not.toHaveProperty('localPath');
  } finally {
    await client.close();
  }
});
