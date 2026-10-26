import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Platform } from '@weq/platform';
import { AgentLabStore, AgentRuntime } from '@weq/agentlab';
import { AgentLabConfigService } from '../src/bootstrap/agentlab_config';
import { UserConfigService } from '../src/bootstrap/user_config';
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

it('真实克隆运行时在默认向量模型更换后拒绝混用旧索引，尚未发出 API 请求', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-default-runtime-'));
  roots.push(root);
  const config = new AgentLabConfigService(
    new UserConfigService({ appDataRoot: () => root } as Platform),
  );
  config.saveProvider({
    id: 'synthetic',
    name: '合成提供方',
    vendor: 'custom',
    baseUrl: 'https://synthetic.invalid',
    apiKey: 'synthetic',
    models: [
      { id: 'first', capabilities: ['chat', 'embedding'] },
      { id: 'second', capabilities: ['chat', 'embedding'] },
    ],
  });
  config.setDefaultModel({ providerId: 'synthetic', model: 'first' });
  const persona = makeBackupPersona();
  persona.models = { chat: { useDefault: true }, embedding: { useDefault: true } };
  persona.embeddingModelIdentity = config.resolveEndpoint(
    { useDefault: true },
    'embedding',
  ).modelIdentity;
  expect(persona.embeddingModelIdentity).toBeTruthy();
  const store = new AgentLabStore(join(root, 'personas'));
  store.savePersona({ persona, pairs: [] });
  const runtime = new AgentRuntime({
    rootDir: root,
    store,
    endpoints: (ref, capability) => config.resolveEndpoint(ref, capability),
    usage: new TokenUsageStore(join(root, 'usage.json')),
    conversations: new ConversationStore(join(root, 'conversations.json')),
    memories: new MemoryStore(join(root, 'memories.json')),
    notes: new NotesStore(join(root, 'notes.json')),
    relations: new JsonRelationStore(join(root, 'relations.json')),
    selfId: '10001',
  });
  config.setDefaultModel({ providerId: 'synthetic', model: 'second' });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    runtime.chat({ personaId: persona.id, history: [], text: '合成问题' }),
  ).rejects.toThrow('重新训练');
  expect(fetch).not.toHaveBeenCalled();
  expect(store.getPersona(persona.id)?.persona.embeddingModelIdentity).toBe(
    persona.embeddingModelIdentity,
  );
});
