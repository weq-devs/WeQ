import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSourceSearchQuery } from '../src/main/source_search';
import { sourceSearchRequest, sourceSearchResponse } from '../src/main/source_search_protocol';
let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function worker(body: string) {
  root = mkdtempSync(join(tmpdir(), 'weq-search-worker-'));
  const path = join(root, 'worker.mjs');
  writeFileSync(path, body);
  return path;
}
it('passes sensitive target and bigint parameters only through stdin and validates positional rows', async () => {
  const path = worker(
    `let input='';for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input);process.stdout.write(JSON.stringify({ok:true,rows:[[request.params[0],request.target.key,process.argv.length]]}));`,
  );
  const query = createSourceSearchQuery({
    workerPath: path,
    executable: process.execPath,
    nativeRoot: '/fixture',
  });
  const rows = await query(
    { dbPath: '/fixture/source', key: 'fixture-only-key' },
    'SELECT ?',
    [7318775631454291968n],
    'search',
  );
  expect(rows).toEqual([['7318775631454291968', 'fixture-only-key', 2]]);
});
it('preserves native errors and cancels its own in-flight process on source closure', async () => {
  const path = worker(
    `process.stdout.write(JSON.stringify({ok:false,error:'no such tokenizer: fixture'}));process.exitCode=1;`,
  );
  const query = createSourceSearchQuery({
    workerPath: path,
    executable: process.execPath,
    nativeRoot: '/fixture',
  });
  await expect(query({ dbPath: '/fixture/source' }, 'SELECT 1', [], 'search')).rejects.toThrow(
    'no such tokenizer',
  );
  writeFileSync(path, 'setInterval(()=>{},1000);');
  const abort = new AbortController();
  const pending = query({ dbPath: '/fixture/source' }, 'SELECT 1', [], 'search', abort.signal);
  const assertion = expect(pending).rejects.toThrow('source closed');
  setTimeout(() => abort.abort(new Error('source closed')), 40);
  await assertion;
});
it('rejects unsupported binary parameters and malformed worker responses', () => {
  expect(
    sourceSearchRequest.safeParse({
      target: { dbPath: '/fixture' },
      sql: 'SELECT ?',
      params: [new Uint8Array([1])],
    }).success,
  ).toBe(false);
  expect(
    sourceSearchResponse.safeParse({ ok: true, rows: [{ named: 'not positional' }] }).success,
  ).toBe(false);
});
