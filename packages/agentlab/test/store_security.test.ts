import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentLabStore, type StoredPersonaRecord } from '../src/store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-persona-security-'));
  roots.push(root);
  const dir = join(root, 'personas');
  mkdirSync(dir);
  const outside = join(root, 'outside.json');
  const record = {
    persona: { id: 'valid-old_id-123', updatedAt: 1 },
    pairs: [],
  } as unknown as StoredPersonaRecord;
  writeFileSync(outside, JSON.stringify(record));
  return { root, dir, outside, record, store: new AgentLabStore(dir) };
}

it.each([
  '../outside',
  '..\\outside',
  '/tmp/outside',
  'C:\\outside',
  '%2e%2e%2foutside',
  'a/b',
  'a\\b',
  '.',
  '..',
  'a\0b',
])('rejects invalid persona ID %j before filesystem access', (id) => {
  const f = fixture();
  const before = readFileSync(f.outside, 'utf8');
  expect(() => f.store.getPersona(id)).toThrow();
  expect(() => f.store.deletePersona(id)).toThrow();
  expect(() =>
    f.store.savePersona({ ...f.record, persona: { ...f.record.persona, id } }),
  ).toThrow();
  expect(readFileSync(f.outside, 'utf8')).toBe(before);
});

it('round-trips existing opaque IDs and rejects symlink entries', () => {
  const f = fixture();
  f.store.savePersona(f.record);
  expect(f.store.getPersona(f.record.persona.id)).toEqual(f.record);
  symlinkSync(f.outside, join(f.dir, 'linked.json'));
  expect(() => f.store.getPersona('linked')).toThrow();
  expect(() => f.store.deletePersona('linked')).toThrow();
  expect(f.store.listPersonas()).toEqual([f.record.persona]);
  expect(readFileSync(f.outside, 'utf8')).toBe(JSON.stringify(f.record));
});

it('reports corrupt records without treating them as absent', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'broken.json'), '{broken');
  expect(() => f.store.getPersona('broken')).toThrow(/克隆/);
});

it('克隆目录混有会话、记忆及其他辅助 JSON 时仍能列出全部克隆体', () => {
  const f = fixture();
  f.store.savePersona(f.record);
  const newer = { ...f.record, persona: { ...f.record.persona, id: 'new-clone', updatedAt: 2 } };
  f.store.savePersona(newer);
  const auxiliary = {
    'conversations.json': { 'new-clone:session': [] },
    'sessions.json': { 'new-clone': [] },
    'memories.json': {},
    'usage.json': [],
    'assistant.json': { customPrompt: '合成助手配置' },
    'future-metadata.json': { enabled: true },
  };
  for (const [file, value] of Object.entries(auxiliary))
    writeFileSync(join(f.dir, file), JSON.stringify(value));
  expect(f.store.listPersonas()).toEqual([newer.persona, f.record.persona]);
  for (const [file, value] of Object.entries(auxiliary))
    expect(readFileSync(join(f.dir, file), 'utf8')).toBe(JSON.stringify(value));
  expect(() => f.store.getPersona('conversations')).toThrow(/克隆/);
});

it('含有克隆画像但记录不完整时仍报告损坏，不覆盖原件', () => {
  const f = fixture();
  const path = join(f.dir, 'broken.json');
  const original = JSON.stringify({ persona: { id: 'broken', updatedAt: 1 } });
  writeFileSync(path, original);
  expect(() => f.store.listPersonas()).toThrow(/克隆/);
  expect(() =>
    f.store.savePersona({ ...f.record, persona: { ...f.record.persona, id: 'broken' } }),
  ).toThrow(/克隆/);
  expect(readFileSync(path, 'utf8')).toBe(original);
});
