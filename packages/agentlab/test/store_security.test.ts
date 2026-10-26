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
