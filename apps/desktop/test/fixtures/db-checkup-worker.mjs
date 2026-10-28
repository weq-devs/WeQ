import { writeFileSync } from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const target = JSON.parse(input);
if (target.dbName === 'hang.db') {
  writeFileSync(target.dbPath, String(process.pid));
  // 模拟卡在原生结构检查或逐页扫描，不处理任何取消消息。
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(
    JSON.stringify({
      dbName: target.dbName,
      dbPath: target.dbPath,
      bytes: 0,
      integrity: { ran: true, healthy: true, corruptedTables: [] },
      pages: { ran: false, error: 'synthetic' },
      verdict: 'healthy-unverified',
      summary: process.argv.includes(target.key) ? 'key leaked' : 'synthetic result',
    }),
  );
}
