import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  retireSearchIndex,
  type SearchRetirementOptions,
} from '../src/common/search_index_retirement';

let temporary: string | undefined;
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
async function fixture() {
  temporary = await mkdtemp(join(tmpdir(), 'weq-retire-search-'));
  const root = join(temporary, 'cache'),
    directory = join(root, 'group_msg_fts'),
    sourcePath = join(temporary, 'qq-source.db');
  await mkdir(directory, { recursive: true });
  await writeFile(sourcePath, 'original');
  await writeFile(join(directory, 'index.db'), 'owned-index');
  await writeFile(join(directory, 'index.db-wal'), 'wal');
  const options: SearchRetirementOptions = {
    root,
    sourcePath,
    table: 'group_msg_fts',
    inspect: async (path) => (await readFile(path, 'utf8')) === 'owned-index',
    unheld: async () => true,
  };
  return { root, directory, sourcePath, options };
}
it('retires only the known derived cache and leaves the QQ source intact', async () => {
  const f = await fixture();
  expect(await retireSearchIndex(f.options)).toEqual({ status: 'retired' });
  expect(await readFile(f.sourcePath, 'utf8')).toBe('original');
  expect((await readdir(f.root)).some((name) => name.startsWith('.retired-'))).toBe(false);
  expect(await retireSearchIndex(f.options)).toEqual({ status: 'retired' });
});
it('retains open or unrecognized caches instead of deleting other files', async () => {
  const f = await fixture();
  expect(await retireSearchIndex({ ...f.options, unheld: async () => false })).toEqual({
    status: 'busy',
  });
  await writeFile(join(f.directory, 'notes.txt'), 'keep');
  expect(await retireSearchIndex(f.options)).toEqual({ status: 'unrecognized' });
  expect(await readFile(join(f.directory, 'notes.txt'), 'utf8')).toBe('keep');
});
it('resumes partial removal after interruption without touching a recreated cache directory', async () => {
  const f = await fixture();
  await expect(
    retireSearchIndex({
      ...f.options,
      remove: async (path) => {
        await unlink(join(path, 'index.db'));
        throw new Error('interrupted');
      },
    }),
  ).rejects.toThrow('interrupted');
  await mkdir(f.directory);
  await writeFile(join(f.directory, 'index.db'), 'new cache');
  expect(await retireSearchIndex(f.options)).toEqual({ status: 'retired' });
  expect(await readFile(join(f.directory, 'index.db'), 'utf8')).toBe('new cache');
  expect(await readFile(f.sourcePath, 'utf8')).toBe('original');
});
it('refuses mismatched journal destinations and never treats the original database as a cache', async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, '.group_msg_fts-retirement.json'),
    JSON.stringify({ version: 1, table: 'group_msg_fts', target: f.sourcePath, phase: 'renamed' }),
  );
  expect(await retireSearchIndex(f.options)).toEqual({ status: 'unrecognized' });
  expect(await readFile(f.sourcePath, 'utf8')).toBe('original');
});
it('honors cancellation before creating a retirement receipt', async () => {
  const f = await fixture(),
    abort = new AbortController();
  abort.abort(new Error('closed'));
  await expect(retireSearchIndex({ ...f.options, signal: abort.signal })).rejects.toThrow('closed');
  expect(await readdir(f.root)).toEqual(['group_msg_fts']);
});
it('serializes competing retirement workers and releases the lock after completion', async () => {
  const f = await fixture();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first = true;
  const pending = retireSearchIndex({
    ...f.options,
    inspect: async (path) => {
      if (first) {
        first = false;
        started();
        await gate;
      }
      return f.options.inspect(path);
    },
  });
  await began;
  expect(await retireSearchIndex(f.options)).toEqual({ status: 'busy' });
  release();
  expect(await pending).toEqual({ status: 'retired' });
  expect(await retireSearchIndex(f.options)).toEqual({ status: 'retired' });
});
