import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLabStore, AgentRuntime, type RuntimeLogger } from '@weq/agentlab';
import { BotOrchestrator } from '../../bot/src/orchestrator';
import type { IncomingEvent, OneBot11Adapter } from '../../bot/src/adapter/types';
import { afterEach, expect, it, vi } from 'vitest';
import {
  JsonConversationStore,
  JsonMemoryStore,
  JsonNotesStore,
  JsonRelationStore,
} from '../../bot/src/stores';
import { makeBackupPersona } from './fixtures/backup_persona';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-bot-private-'));
  roots.push(root);
  const persona = makeBackupPersona();
  persona.typo = { enabled: false, intensity: 0 };
  persona.models.embedding = { providerId: 'synthetic-provider', model: 'synthetic' };
  const store = new AgentLabStore(join(root, 'personas'));
  store.savePersona({ persona, pairs: [] });
  const open = (selfId = 'synthetic-bot') => {
    const conversations = new JsonConversationStore(join(root, 'conversations.json'));
    const memories = new JsonMemoryStore(join(root, 'memories.json'));
    const notes = new JsonNotesStore(join(root, 'notes.json'));
    const error = vi.fn();
    const logger: RuntimeLogger = { child: () => logger, info: () => {}, warn: () => {}, error };
    const runtime = new AgentRuntime({
      rootDir: root,
      store,
      endpoints: () => ({
        baseUrl: 'https://synthetic.invalid',
        apiKey: 'synthetic',
        model: 'synthetic',
      }),
      usage: { record: () => {} },
      conversations,
      memories,
      notes,
      relations: new JsonRelationStore(join(root, 'relations.json')),
      selfId,
      logger,
    });
    return { runtime, conversations, memories, notes, error };
  };
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = String(init.body);
      requests.push(body);
      if (String(_url).endsWith('/embeddings')) {
        const { input } = JSON.parse(body) as { input: string[] };
        return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0] })) }));
      }
      const content = body.includes('提炼出关于')
        ? JSON.stringify({ memories: ['近况 A_PRIVATE_MARKER'] })
        : body.includes('corrections：')
          ? JSON.stringify({ corrections: ['A_PRIVATE_CORRECTION'], summary: 'A_PRIVATE_EPISODE' })
          : '合成回复';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { root, persona, open, requests };
}

it('双用户的真实生成、蒸馏、反思与重启互不串入，保留共享人设和旧原件', async () => {
  const f = fixture();
  let state = f.open();
  state.memories.add(f.persona.id, ['近况 LEGACY_MIXED_MARKER'], 1);
  state.notes.add(f.persona.id, ['LEGACY_CORRECTION'], 'LEGACY_EPISODE');
  state.conversations.append(f.persona.id, [{ role: 'user', text: 'LEGACY_CONVERSATION', ts: 1 }]);
  const input = {
    personaId: f.persona.id,
    history: [],
    text: '近况 A_PRIVATE_MARKER',
    privatePeerId: 'peer-a',
  };
  for (let i = 0; i < 8; i++) await state.runtime.chat(input);
  await vi.waitFor(() => {
    const raw = readFileSync(join(f.root, 'memories.json'), 'utf8');
    expect(raw).toContain('A_PRIVATE_MARKER');
    expect(raw).toContain('embedding');
    expect(readFileSync(join(f.root, 'notes.json'), 'utf8')).toContain('A_PRIVATE_EPISODE');
  });
  const notesRaw = JSON.parse(readFileSync(join(f.root, 'notes.json'), 'utf8')) as {
    notes: Record<string, unknown>;
  };
  expect(Object.keys(notesRaw.notes)).toHaveLength(2);
  expect(f.requests.join('\n')).not.toContain('LEGACY_');
  state = f.open();
  f.requests.length = 0;
  await state.runtime.chat({ ...input, privatePeerId: 'peer-b', text: '近况' });
  expect(f.requests.join('\n')).not.toContain('A_PRIVATE_');
  expect(f.requests.join('\n')).not.toContain('LEGACY_');
  expect(f.requests.join('\n')).toContain('合成语气');
  f.requests.length = 0;
  await state.runtime.chat({ ...input, sessionId: 'another-session', text: '近况' });
  expect(f.requests.join('\n')).toContain('A_PRIVATE_MARKER');
  expect(f.requests.join('\n')).toContain('A_PRIVATE_CORRECTION');
  expect(state.memories.get(f.persona.id)[0]!.text).toContain('LEGACY_');
  expect(state.conversations.get(f.persona.id)[0]!.text).toBe('LEGACY_CONVERSATION');

  f.requests.length = 0;
  await f.open('other-bot').runtime.chat({ ...input, text: '近况' });
  expect(f.requests.join('\n')).not.toContain('A_PRIVATE_');
  f.requests.length = 0;
  await state.runtime.handleGroupMessage({
    personaId: f.persona.id,
    senderId: 'peer-a',
    senderName: '合成群友',
    groupId: 'peer-a',
    text: '近况',
    mentionsSelf: true,
    history: [],
  });
  expect(f.requests.join('\n')).not.toContain('A_PRIVATE_');
  expect(f.requests.join('\n')).not.toContain('LEGACY_');
});

it('后台记忆保存失败会告警且不发布未落盘记忆，不自动重试模型', async () => {
  const f = fixture();
  const state = f.open();
  mkdirSync(join(f.root, 'memories.json'));
  for (let i = 0; i < 6; i++) {
    await state.runtime.chat({
      personaId: f.persona.id,
      privatePeerId: 'peer-a',
      text: '合成问题',
      history: [],
    });
  }
  await vi.waitFor(() =>
    expect(state.error).toHaveBeenCalledWith('记忆蒸馏或保存失败，未报告为已记住'),
  );
  expect(f.requests.filter((body) => body.includes('提炼出关于'))).toHaveLength(1);
  expect(state.error.mock.calls.flat().join(' ')).not.toContain('合成问题');
});

it('迟到的后台蒸馏仍只写回原对端，不跟随当前会话', async () => {
  const f = fixture();
  const state = f.open();
  const original = vi.mocked(fetch).getMockImplementation()!;
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let distilling = false;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(init?.body).includes('提炼出关于')) {
      distilling = true;
      await pending;
    }
    return original(url, init);
  });
  const input = {
    personaId: f.persona.id,
    privatePeerId: 'peer-a',
    text: '近况 A_PRIVATE_MARKER',
    history: [],
  };
  for (let i = 0; i < 6; i++) await state.runtime.chat(input);
  expect(distilling).toBe(true);
  f.requests.length = 0;
  await state.runtime.chat({ ...input, privatePeerId: 'peer-b', text: '近况' });
  expect(f.requests.join('\n')).not.toContain('A_PRIVATE_');
  release();
  await vi.waitFor(() =>
    expect(readFileSync(join(f.root, 'memories.json'), 'utf8')).toContain('A_PRIVATE_MARKER'),
  );
  f.requests.length = 0;
  await state.runtime.chat({ ...input, privatePeerId: 'peer-b', text: '近况' });
  expect(f.requests.join('\n')).not.toContain('A_PRIVATE_');
});

it('实际编排从传输身份提供私聊和群作用域，同号群不复用私聊短期历史', async () => {
  const f = fixture();
  const state = f.open();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const actualChat = state.runtime.chat.bind(state.runtime);
  const chat = vi
    .spyOn(state.runtime, 'chat')
    .mockImplementation(async (input) => ({ ...(await actualChat(input)), replyDelayMs: 0 }));
  const actualGroup = state.runtime.handleGroupMessage.bind(state.runtime);
  const groupHistories: unknown[] = [];
  const group = vi.spyOn(state.runtime, 'handleGroupMessage').mockImplementation(async (input) => {
    groupHistories.push(structuredClone(input.history));
    return { ...(await actualGroup(input)), replyDelayMs: 0 };
  });
  let handler: (event: IncomingEvent) => void = () => {
    throw new Error('尚未注册');
  };
  const adapter: OneBot11Adapter = {
    type: 'napcat',
    connect: async () => {},
    close: () => {},
    onEvent: (callback) => {
      handler = callback;
    },
    sendMessage: vi.fn(async () => ({})),
    callAction: async () => ({}),
  };
  new BotOrchestrator(
    adapter,
    state.runtime,
    f.persona.id,
    'synthetic-bot',
    { stickerPath: () => null, voicePath: () => null },
    { groupChat: true },
  ).start();
  handler({
    post_type: 'message',
    message_type: 'private',
    user_id: 'same-id',
    message: 'A_PRIVATE_MARKER',
  });
  await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledTimes(1));
  handler({
    post_type: 'message',
    message_type: 'group',
    group_id: 'same-id',
    user_id: 'same-id',
    message: [
      { type: 'at', data: { qq: 'synthetic-bot' } },
      { type: 'text', data: { text: '合成问题' } },
    ],
  });
  await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledTimes(2));
  expect(chat.mock.calls[0]![0]).toMatchObject({ privatePeerId: 'same-id' });
  expect(group.mock.calls[0]![0]).toMatchObject({ groupId: 'same-id' });
  expect(groupHistories).toEqual([[]]);
});

it('未传对端身份的桌面调用保持旧桶与多会话聚合兼容', async () => {
  const f = fixture();
  const state = f.open();
  state.notes.add(f.persona.id, ['DESKTOP_CORRECTION'], 'DESKTOP_EPISODE');
  await state.runtime.chat({
    personaId: f.persona.id,
    sessionId: 'desktop-session',
    text: '合成问题',
    history: [],
  });
  expect(f.requests.join('\n')).toContain('DESKTOP_CORRECTION');
  expect(state.conversations.get(`${f.persona.id}:desktop-session`)).toHaveLength(2);
});
