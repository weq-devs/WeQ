import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

export function macForceClickAsset(source: string): Plugin {
  let built: { mtime: number; binding: Buffer } | undefined;
  return {
    name: 'weq-macos-force-click',
    buildStart() {
      if (process.platform !== 'darwin') return;
      this.addWatchFile(source);
      const mtime = statSync(source).mtimeMs;
      if (built?.mtime !== mtime) {
        const directory = mkdtempSync(join(tmpdir(), 'weq-force-click-'));
        try {
          const output = join(directory, 'force-click.node');
          const headers = resolve(realpathSync(process.execPath), '../../include/node');
          execFileSync('xcrun', [
            'clang',
            '-arch',
            'arm64',
            '-arch',
            'x86_64',
            '-mmacosx-version-min=12.0',
            '-bundle',
            '-undefined',
            'dynamic_lookup',
            '-fobjc-arc',
            '-Wall',
            '-Wextra',
            '-I',
            headers,
            '-framework',
            'AppKit',
            source,
            '-o',
            output,
          ]);
          built = { mtime, binding: readFileSync(output) };
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
      this.emitFile({ type: 'asset', fileName: 'force-click.node', source: built.binding });
    },
  };
}
