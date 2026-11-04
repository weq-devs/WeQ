import { loadNative } from '@weq/native';
import { sourceSearchRequest } from './source_search_protocol';

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 256 * 1024) throw new Error('搜索请求过大');
  }
  const request = sourceSearchRequest.parse(JSON.parse(input));
  input = '';
  const { ntHelper } = loadNative();
  try {
    const { target, sql, params } = request;
    const rows =
      target.key && target.algo
        ? await ntHelper.executeSqlWithKey(target.dbPath, sql, target.key, target.algo, params)
        : await ntHelper.executeSql(target.dbPath, sql, params);
    process.stdout.write(
      JSON.stringify({ ok: true, rows }, (_, value) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    );
  } finally {
    ntHelper.closeAllDb();
  }
}
void main().catch((error: unknown) => {
  process.stdout.write(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '搜索读取失败' }),
  );
  process.exitCode = 1;
});
