import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAtomicExportBundle } from '../src/account/export/atomic_bundle';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('atomic export bundle', () => {
  it('keeps the final directory invisible until publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-bundle-'));
    roots.push(root);
    const bundle = createAtomicExportBundle(root, 'task-1');
    writeFileSync(join(bundle.stageDir, 'body.json'), '{}');
    expect(existsSync(bundle.finalDir)).toBe(false);
    bundle.publish();
    expect(readFileSync(join(bundle.finalDir, 'body.json'), 'utf8')).toBe('{}');
    expect(existsSync(bundle.stageDir)).toBe(false);
  });

  it('discards a failed staging directory without publishing it', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-bundle-'));
    roots.push(root);
    const bundle = createAtomicExportBundle(root, 'task-2');
    writeFileSync(join(bundle.stageDir, 'partial.json'), '{');
    bundle.discard();
    expect(existsSync(bundle.stageDir)).toBe(false);
    expect(existsSync(bundle.finalDir)).toBe(false);
  });
});
