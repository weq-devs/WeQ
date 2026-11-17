import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentLabStore, AgentRuntime, TtsService } from '@weq/agentlab';
import { ConversationStore } from '../src/account/agentlab_conversation';
import { TokenUsageStore } from '../src/account/agentlab_usage';
import { MemoryStore } from '../src/account/agentlab_memory';
import { NotesStore } from '../src/account/agentlab_notes';
import { JsonRelationStore } from '../src/account/agentlab_relation_store';
import { makeBackupPersona } from './fixtures/backup_persona';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([true, false])(
  '克隆语音 success=%s 保留业务、克隆体与未知用量，合并全局账本不重复',
  async (success) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-clone-voice-usage-'));
    roots.push(root);
    const usage = new TokenUsageStore(join(root, 'account.json'));
    const global = new TokenUsageStore(join(root, 'global.json'));
    const tts = new TtsService((u) => global.record({ ...u, ts: u.startedAt!, scope: 'tts' }));
    const persona = makeBackupPersona();
    persona.voice = { providerId: 'fixture', mode: 'preset', voice: 'fixture' };
    const runtime = new AgentRuntime({
      rootDir: root,
      store: new AgentLabStore(join(root, 'personas')),
      endpoints: () => {
        throw new Error('不应请求聊天模型');
      },
      usage,
      conversations: new ConversationStore(join(root, 'conversations.json')),
      memories: new MemoryStore(join(root, 'memories.json')),
      notes: new NotesStore(join(root, 'notes.json')),
      relations: new JsonRelationStore(join(root, 'relations.json')),
      selfId: '10001',
      tts: {
        getCapabilities: () => ({ clone: false, fixedVoice: true }),
        synthesize: (_id, text, opts) =>
          tts.synthesize(
            {
              id: 'fixture',
              name: '合成语音',
              vendor: 'openai-compatible',
              baseUrl: 'https://fixture.invalid',
              apiKey: 'fixture',
              model: 'fixture',
              createdAt: 0,
              updatedAt: 0,
            },
            text,
            opts,
          ),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        success
          ? new Response(new Uint8Array(101).fill(1))
          : new Response('denied', { status: 403 }),
      ),
    );
    const result = await runtime.synthesizeVoice(persona, '合成文本');
    expect(result === null).toBe(!success);
    expect(global.getStats().totalCalls).toBe(0);
    const stats = usage.getStats(global);
    expect(stats).toMatchObject({
      totalCalls: 1,
      unknownCalls: 1,
      failedCalls: success ? 0 : 1,
      globalCalls: 0,
    });
    expect(stats.byCategory).toEqual([
      {
        category: 'clone',
        label: '克隆会话',
        calls: 1,
        tokens: 0,
        unknownCalls: 1,
        features: [
          { feature: 'tts-synthesis', label: '语音合成', calls: 1, tokens: 0, unknownCalls: 1 },
        ],
      },
    ]);
    expect(stats.byPersona).toEqual([
      { personaId: persona.id, calls: 1, tokens: 0, unknownCalls: 1 },
    ]);
  },
);
