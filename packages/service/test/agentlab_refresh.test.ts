import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { C2cMsg } from '@weq/db';
import { AgentLabStore, GROUP_SUPPLEMENT_THRESHOLD } from '@weq/agentlab';
import { AgentLabService } from '../src/account/agentlab';
import { makeBackupPersona } from './fixtures/backup_persona';
import { buildWeqBackup, readWeqBackup } from '../src/bootstrap/backup_bundle';
import { validateWeqBackupData } from '../src/bootstrap/backup_data';

const mocks = vi.hoisted(() => ({ card: vi.fn(), embed: vi.fn() }));
vi.mock('@weq/agentlab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weq/agentlab')>();
  return {
    ...actual,
    extractPersonaCard: mocks.card,
    embedTexts: mocks.embed,
    extractFewShots: async () => [],
    extractExpressions: async () => [],
    extractStyleVariants: async () => [],
    renderProfileChunks: () => [],
  };
});
const roots: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.card.mockResolvedValue({ ...makeBackupPersona().profile.card, tone: '最新语气' });
  mocks.embed.mockResolvedValue([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('单测禁止联网');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-clone-refresh-'));
  roots.push(root);
  const store = new AgentLabStore(root);
  const persona = {
    ...makeBackupPersona(),
    name: '自定义名称',
    customPrompt: '保留提示',
    voiceCloneEnabled: true,
    voice: { providerId: 'synthetic-tts', mode: 'preset' as const, voice: 'synthetic' },
    willing: { level: 42 },
    typo: { enabled: false },
  };
  store.savePersona({ persona, pairs: [] });
  const messages = Array.from({ length: (GROUP_SUPPLEMENT_THRESHOLD + 1) * 2 }, (_, index) => ({
    msgSeq: BigInt(index + 1),
    senderUin: index % 2 ? 10002n : 10001n,
    sendTime: BigInt(1000 + index * 60),
    elements: [
      { kind: 'text', textContent: index % 2 ? `最新回复内容${index}` : `合成问题内容${index}` },
    ],
  })).reverse() as unknown as C2cMsg[];
  const latest = vi.fn(async () => messages);
  const session = {
    context: { uin: '10001' },
    uidMap: { sortNoByUid: () => undefined },
    profileInfo: { getProfileByUin: async () => null, getProfile: async () => null },
    c2cMsgs: { listLatest: latest, listBefore: async () => [] },
  } as unknown as AccountSession;
  const service = new AgentLabService(session, root, () => ({
    baseUrl: 'https://synthetic.invalid',
    apiKey: 'synthetic',
    model: 'synthetic',
  }));
  return { root, store, persona, service, latest, messages };
}

it('用最新真实语料路径重训并原位保存，配置、身份及所有独立历史文件不变', async () => {
  const f = fixture();
  const sidecars = ['conversations', 'sessions', 'memories', 'notes', 'groups', 'relations'];
  for (const name of sidecars)
    writeFileSync(join(f.root, `${name}.json`), `{"synthetic-${name}":[1]}`);
  const before = sidecars.map((name) => readFileSync(join(f.root, `${name}.json`), 'utf8'));
  const result = await f.service.refreshFromC2c(f.persona.id);
  expect(f.latest).toHaveBeenCalledWith({ uid: f.persona.sourceId }, 500);
  expect(result).toMatchObject({
    id: f.persona.id,
    ownerId: f.persona.ownerId,
    name: f.persona.name,
    models: f.persona.models,
    createdAt: f.persona.createdAt,
    customPrompt: f.persona.customPrompt,
    voice: f.persona.voice,
    voiceCloneEnabled: true,
    willing: f.persona.willing,
    typo: f.persona.typo,
    training: { mode: 'private', autoName: false },
  });
  expect(result.profile.card.tone).toBe('最新语气');
  expect(result.corpusMessageCount).toBe(f.messages.length);
  expect(result.updatedAt).toBeGreaterThan(f.persona.updatedAt);
  expect(result.trainedAt).toBe(result.updatedAt);
  expect(f.store.getPersona(f.persona.id)?.pairs.length).toBeGreaterThan(0);
  expect(sidecars.map((name) => readFileSync(join(f.root, `${name}.json`), 'utf8'))).toEqual(
    before,
  );
  expect(fetch).not.toHaveBeenCalled();
});

it('沿用已保存的训练范围，并保留训练期间新保存的配置', async () => {
  const f = fixture();
  f.store.savePersona({
    persona: { ...f.persona, training: { mode: 'group', autoName: false, limit: 1000 } },
    pairs: [],
  });
  let finish!: (rows: C2cMsg[]) => void;
  f.latest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.service.refreshFromC2c(f.persona.id);
  await vi.waitFor(() => expect(f.latest).toHaveBeenCalled());
  f.service.updatePersona(f.persona.id, {
    name: '更新期间改名',
    customPrompt: '最新提示',
    generation: { historyMessages: 12 },
  });
  finish(f.messages);
  const result = await pending;
  expect(result.name).toBe('更新期间改名');
  expect(result.customPrompt).toBe('最新提示');
  expect(result.generation?.historyMessages).toBe(12);
  expect(result.training).toEqual({ mode: 'group', autoName: false, limit: 1000 });
});

it.each([
  ['语料不足', '语料太少'],
  ['画像失败', '画像提炼失败'],
  ['向量失败', '向量索引更新失败'],
])('更新%s时原克隆文件保持完整', async (failure, message) => {
  const f = fixture();
  if (failure === '语料不足') f.latest.mockResolvedValueOnce([]);
  if (failure === '画像失败') mocks.card.mockRejectedValueOnce(new Error('合成模型失败'));
  if (failure === '向量失败') {
    f.store.savePersona({
      persona: {
        ...f.persona,
        models: { ...f.persona.models, embedding: { providerId: 'synthetic', model: 'embedding' } },
      },
      pairs: [],
    });
    mocks.embed.mockRejectedValueOnce(new Error('合成向量失败'));
  }
  const path = join(f.root, `${f.persona.id}.json`);
  const original = readFileSync(path, 'utf8');
  await expect(f.service.refreshFromC2c(f.persona.id)).rejects.toThrow(message);
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(fetch).not.toHaveBeenCalled();
  expect((await f.service.refreshFromC2c(f.persona.id)).id).toBe(f.persona.id);
});

it('拒绝并发更新，构建期间删除克隆体后不将其复活', async () => {
  const f = fixture();
  let finish!: (rows: C2cMsg[]) => void;
  f.latest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.service.refreshFromC2c(f.persona.id);
  await vi.waitFor(() => expect(f.latest).toHaveBeenCalled());
  await expect(f.service.refreshFromC2c(f.persona.id)).rejects.toThrow('正在创建或更新');
  f.store.deletePersona(f.persona.id);
  finish(f.messages);
  await expect(pending).rejects.toThrow('已删除或替换');
  expect(f.store.getPersona(f.persona.id)).toBeNull();
  await expect(f.service.refreshFromC2c(f.persona.id)).rejects.toThrow('已不存在');
});

it('训练元数据不能覆盖原克隆 ID 或语料来源', async () => {
  const f = fixture();
  f.store.savePersona({
    persona: {
      ...f.persona,
      training: Object.assign(
        { mode: 'private' as const, autoName: false },
        { personaId: 'other-clone', targetUid: 'u_other' },
      ),
    },
    pairs: [],
  });
  const result = await f.service.refreshFromC2c(f.persona.id);
  expect(result.id).toBe(f.persona.id);
  expect(f.latest).toHaveBeenCalledWith({ uid: f.persona.sourceId }, 500);
  expect(f.store.getPersona('other-clone')).toBeNull();
});

it('新建克隆保存原训练方式供后续更新复用', async () => {
  const f = fixture();
  const result = await f.service.buildFromC2c({
    personaId: 'new-clone',
    targetUid: f.persona.sourceId,
    models: f.persona.models,
    mode: 'group',
    autoName: false,
    limit: 1000,
  });
  expect(f.store.getPersona(result.id)?.persona.training).toEqual({
    mode: 'group',
    autoName: false,
    limit: 1000,
  });
  expect(result.trainedAt).toBe(result.createdAt);
});

it('保存用户配置不改变画像训练时间，旧克隆首次编辑时固定原更新时间', () => {
  const f = fixture();
  const edited = f.service.updatePersona(f.persona.id, { name: '改名' });
  expect(edited?.trainedAt).toBe(f.persona.updatedAt);
  const editedAgain = f.service.updatePersona(f.persona.id, { customPrompt: '新提示' });
  expect(editedAgain?.trainedAt).toBe(f.persona.updatedAt);
});

it.each([
  { mode: 'private', autoName: false, limit: 1000 },
  { mode: 'outside', autoName: false },
  { mode: 'group', autoName: 'false' },
  { mode: 'private', autoName: false, limit: 20001 },
])('备份恢复校验训练配置 $mode / $limit', (training) => {
  const persona = makeBackupPersona();
  const bundle = readWeqBackup(
    buildWeqBackup([
      {
        path: `clones/10001/${persona.id}.json`,
        data: Buffer.from(JSON.stringify({ persona: { ...persona, training }, pairs: [] })),
      },
    ]),
  );
  if (training.limit === 1000) expect(() => validateWeqBackupData(bundle)).not.toThrow();
  else expect(() => validateWeqBackupData(bundle)).toThrow(/training/);
});
