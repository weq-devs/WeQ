// @vitest-environment node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  deduplicateOnnxLibraries,
  pruneWorkerChunks,
} from '../../../scripts/trim-desktop-package.mjs';

function fixture(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'weq-package-trim-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('同版本 ONNX 动态库去重', () => {
  for (const [version, alias] of [
    ['1.30.0', 'libonnxruntime.1.dylib'],
    ['1.24.4', 'libonnxruntime.dylib'],
  ]) {
    it(`${version} 仅将相同内容的别名换成相对链接，重复执行不改变结果`, () => {
      fixture((directory) => {
        const name = `libonnxruntime.${version}.dylib`;
        writeFileSync(join(directory, name), 'same runtime');
        writeFileSync(join(directory, alias), 'same runtime');
        expect(deduplicateOnnxLibraries(directory)).toBe(Buffer.byteLength('same runtime'));
        expect(readlinkSync(join(directory, alias))).toBe(name);
        expect(readFileSync(join(directory, alias), 'utf8')).toBe('same runtime');
        expect(deduplicateOnnxLibraries(directory)).toBe(0);
      });
    });
  }

  it('不替换不同内容、其他版本、已有链接和缺失的库', () => {
    fixture((directory) => {
      expect(deduplicateOnnxLibraries(join(directory, 'missing'))).toBe(0);
      writeFileSync(join(directory, 'libonnxruntime.1.30.0.dylib'), 'new version');
      writeFileSync(join(directory, 'libonnxruntime.1.dylib'), 'old version');
      expect(deduplicateOnnxLibraries(directory)).toBe(0);
      expect(lstatSync(join(directory, 'libonnxruntime.1.dylib')).isFile()).toBe(true);
      writeFileSync(join(directory, 'libonnxruntime.1.24.4.dylib'), 'old version');
      expect(deduplicateOnnxLibraries(directory)).toBe(0);
      symlinkSync('libonnxruntime.1.24.4.dylib', join(directory, 'libonnxruntime.dylib'));
      expect(deduplicateOnnxLibraries(directory)).toBe(0);
      expect(readlinkSync(join(directory, 'libonnxruntime.dylib'))).toBe(
        'libonnxruntime.1.24.4.dylib',
      );
    });
  });
});

describe('独立 worker 的 chunks 闭包', () => {
  it('保留多入口、重导出、静态动态导入和循环引用，移除无关 chunks', () => {
    fixture((directory) => {
      const chunks = join(directory, 'chunks');
      mkdirSync(chunks);
      writeFileSync(join(directory, 'one.mjs'), 'import "./chunks/a.js";');
      writeFileSync(join(directory, 'two.mjs'), 'import("./chunks/c.js");');
      writeFileSync(join(chunks, 'a.js'), 'export * from "./b.js";');
      writeFileSync(join(chunks, 'b.js'), 'import "./a.js"; import "external-package";');
      writeFileSync(
        join(chunks, 'c.js'),
        'loadChunk("./d.cjs"); new URL("./e.js", import.meta.url);',
      );
      writeFileSync(join(chunks, 'd.cjs'), 'module.exports = 42;');
      writeFileSync(join(chunks, 'e.js'), 'export const value = 1;');
      writeFileSync(join(chunks, 'unused.js'), 'unused');
      writeFileSync(join(chunks, 'asset.bin'), 'keep asset');
      expect(pruneWorkerChunks(directory)).toBe(Buffer.byteLength('unused'));
      for (const name of ['a.js', 'b.js', 'c.js', 'd.cjs', 'e.js', 'asset.bin'])
        expect(existsSync(join(chunks, name))).toBe(true);
      expect(existsSync(join(chunks, 'unused.js'))).toBe(false);
      expect(pruneWorkerChunks(directory)).toBe(0);
    });
  });

  it('缺失依赖、计算式 import 或越界路径在删除前报错', () => {
    for (const entry of [
      'import "./chunks/missing.js";',
      'import(variable);',
      'import "../escape.js";',
      'import "/outside/chunk.js";',
      'import "file:///outside/chunk.js";',
    ]) {
      fixture((directory) => {
        mkdirSync(join(directory, 'chunks'));
        writeFileSync(join(directory, 'worker.mjs'), entry);
        writeFileSync(join(directory, 'chunks/keep.js'), 'keep');
        expect(() => pruneWorkerChunks(directory)).toThrow();
        expect(existsSync(join(directory, 'chunks/keep.js'))).toBe(true);
      });
    }
  });

  it('没有 worker 入口时不清除 chunks', () => {
    fixture((directory) => {
      mkdirSync(join(directory, 'chunks'));
      writeFileSync(join(directory, 'chunks/keep.js'), 'keep');
      expect(pruneWorkerChunks(directory)).toBe(0);
      expect(existsSync(join(directory, 'chunks/keep.js'))).toBe(true);
    });
  });
});
