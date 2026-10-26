import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentLabStore, type AgentLabPersona } from '@weq/agentlab';
import { UserConfigService } from '../src/bootstrap/user_config';
import { JsonStore } from '../src/common/json_store';

const fault = vi.hoisted(() => ({ stage: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const error = () => Object.assign(new Error('合成原子写故障'), { code: 'EIO' });
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.stage === 'partial' && typeof args[0] === 'number') {
        fs.writeFileSync(args[0], 'partial');
        throw error();
      }
      return fs.writeFileSync(...args);
    },
    fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => {
      if (fault.stage === 'fsync') throw error();
      return fs.fsyncSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (fault.stage === 'rename') throw error();
      return fs.renameSync(...args);
    },
  };
});
const roots: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-authority-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  fault.stage = '';
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(['partial', 'fsync', 'rename'])(
  'preserves original user config and in-memory state at %s failure',
  (stage) => {
    const dir = root();
    const config = new UserConfigService({ appDataRoot: () => dir });
    config.write({ weqAssistantUid: 'original' });
    const path = join(dir, 'config.json');
    const before = readFileSync(path, 'utf8');
    fault.stage = stage;
    expect(() => config.write({ weqAssistantUid: 'changed' })).toThrow();
    expect(config.read().weqAssistantUid).toBe('original');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  },
);

it.each(['partial', 'fsync', 'rename'])('preserves original persona at %s failure', (stage) => {
  const dir = root();
  const store = new AgentLabStore(dir);
  const persona = { id: 'synthetic', name: 'original', updatedAt: 1 } as AgentLabPersona;
  store.savePersona({ persona, pairs: [] });
  const path = join(dir, 'synthetic.json');
  const before = readFileSync(path, 'utf8');
  fault.stage = stage;
  expect(() =>
    store.savePersona({ persona: { ...persona, name: 'changed' }, pairs: [] }),
  ).toThrow();
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(readdirSync(dir)).toEqual(['synthetic.json']);
});

it('blocks config writes after corruption until explicit repair and reload', () => {
  const dir = root();
  const path = join(dir, 'config.json');
  writeFileSync(path, '{damaged');
  const config = new UserConfigService({ appDataRoot: () => dir });
  expect(() => config.write({ weqAssistantUid: 'changed' })).toThrow('原件');
  expect(readFileSync(path, 'utf8')).toBe('{damaged');
  writeFileSync(path, '{}');
  config.reload();
  config.write({ weqAssistantUid: 'repaired' });
  expect(config.read().weqAssistantUid).toBe('repaired');
});

it.each(['{damaged', 'null'])(
  'even a tolerant JSON store does not overwrite damaged evidence %s on save',
  (content) => {
    const dir = root();
    const path = join(dir, 'cache.json');
    writeFileSync(path, content);
    const store = new JsonStore(path, () => ({ synthetic: 0 }));
    store.data.synthetic = 1;
    store.save();
    expect(readFileSync(path, 'utf8')).toBe(content);
  },
);
