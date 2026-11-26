import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const command = JSON.parse(line);
  if (command.kind === 'begin' && command.targets[0].dbName === 'hang.db') continue;
  if (command.kind === 'begin') {
    process.stdout.write(
      `${JSON.stringify({
        requestId: command.requestId,
        progress: {
          step: 'lock',
          message: '合并预写日志',
          completed: 0,
          total: command.targets.length,
          unit: 'databases',
          objectName: command.targets[0].dbName,
        },
      })}\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ requestId: command.requestId, ...(command.kind === 'begin' ? { databases: command.targets.map(({ dbPath }) => ({ dbPath })) } : { ok: true }) })}\n`,
  );
  if (command.kind === 'end') break;
}
