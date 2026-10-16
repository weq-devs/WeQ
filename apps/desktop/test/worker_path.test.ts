import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { resolveChildWorkerPath } from '../src/main/worker_path';

function fixture(run: (root: string, add: (path: string) => void) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'weq-worker-path-'));
  try {
    run(root, (path) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'fixture');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('packaged worker resolves the physical extraResource rather than asar', () => {
  fixture((root, add) => {
    const physical = join(root, 'out/main/attachWorker.mjs');
    const virtualDir = join(root, 'app.asar/out/main');
    add(physical);
    add(join(virtualDir, 'attachWorker.mjs'));
    assert.equal(resolveChildWorkerPath('attachWorker.mjs', virtualDir, root), physical);
  });
});

test('development and chunked entry resolve sibling and parent workers', () => {
  fixture((root, add) => {
    const worker = join(root, 'out/main/attachWorker.mjs');
    add(worker);
    assert.equal(resolveChildWorkerPath('attachWorker.mjs', dirname(worker), ''), worker);
    assert.equal(
      resolveChildWorkerPath('attachWorker.mjs', join(dirname(worker), 'chunks'), ''),
      worker,
    );
  });
});

test('an asar-only entry or missing worker fails before elevation', () => {
  fixture((root, add) => {
    const dir = join(root, 'app.asar/out/main');
    add(join(dir, 'attachWorker.mjs'));
    assert.throws(() => resolveChildWorkerPath('attachWorker.mjs', dir, root), /缺少可执行/);
    assert.throws(() => resolveChildWorkerPath('missing.mjs', root, root), /缺少可执行/);
  });
});
