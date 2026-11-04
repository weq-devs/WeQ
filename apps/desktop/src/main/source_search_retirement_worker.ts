import { existsSync } from 'node:fs';
import { loadNative } from '@weq/native';
import { retireSearchIndex } from '@weq/service/search-index-retirement';
import { runOwnedChild } from '@weq/service';
import { searchRetirementRequest } from './source_search_retirement_protocol';

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 16384) throw new Error('索引退役请求过大');
  }
  const request = searchRetirementRequest.parse(JSON.parse(input));
  input = '';
  const { ntHelper } = loadNative();
  try {
    const result = await retireSearchIndex({
      ...request,
      inspect: async (path) => {
        try {
          const names = await ntHelper.executeSql(
            path,
            "SELECT name FROM sqlite_master WHERE type='table'",
            [],
          );
          const tables = new Set(names.map((row) => String(row[0])));
          if (!['weq_fts_idx', 'weq_fts_keys', 'weq_fts_meta'].every((name) => tables.has(name)))
            return false;
          const version = await ntHelper.executeSql(
            path,
            "SELECT value FROM weq_fts_meta WHERE key='version'",
            [],
          );
          return String(version[0]?.[0]) === '5';
        } catch {
          return false;
        } finally {
          ntHelper.closeDb(path);
        }
      },
      unheld: async (paths) => {
        const files = paths.filter((path) => existsSync(path));
        if (!files.length) return true;
        if (process.platform !== 'linux')
          return files.every((path) => {
            const probe = ntHelper.probeDbLock(path);
            return probe.success && !probe.locked && probe.holders.length === 0;
          });
        const lsof = ['/usr/bin/lsof', '/usr/sbin/lsof'].find((path) => existsSync(path));
        if (!lsof) return false;
        const probe = await runOwnedChild(lsof, ['-F', 'p', '--', ...files], {
          timeoutMs: 5000,
          maxOutputBytes: 65536,
        });
        return (
          (probe.code === 0 || probe.code === 1) &&
          !probe.signal &&
          !probe.stdout.trim() &&
          !probe.stderr.trim()
        );
      },
    });
    process.stdout.write(JSON.stringify(result));
  } finally {
    ntHelper.closeAllDb();
  }
}
void main().catch(() => {
  process.stdout.write(JSON.stringify({ status: 'busy' }));
  process.exitCode = 1;
});
