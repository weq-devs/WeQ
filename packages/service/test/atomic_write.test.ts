import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomicSync } from '../src/common/atomic_write';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('writeFileAtomicSync', () => {
  it('replaces a complete file without leaving temporary files', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-atomic-'));
    roots.push(root);
    const target = join(root, 'state.json');
    writeFileSync(target, '{"version":1}');
    writeFileAtomicSync(target, '{"version":2}');
    expect(readFileSync(target, 'utf8')).toBe('{"version":2}');
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('supports concurrent writers without sharing one .tmp path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-atomic-'));
    roots.push(root);
    const target = join(root, 'state.json');
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Promise.resolve().then(() => writeFileAtomicSync(target, JSON.stringify({ index }))),
      ),
    );
    expect(() => JSON.parse(readFileSync(target, 'utf8'))).not.toThrow();
    expect(readdirSync(root)).toEqual(['state.json']);
  });
});
