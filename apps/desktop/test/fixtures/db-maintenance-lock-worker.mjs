import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const command = JSON.parse(line);
  if (command.kind === 'begin' && command.targets[0].dbName === 'hang.db') continue;
  process.stdout.write(
    `${JSON.stringify({ requestId: command.requestId, ...(command.kind === 'begin' ? { databases: command.targets.map(({ dbPath }) => ({ dbPath })) } : { ok: true }) })}\n`,
  );
  if (command.kind === 'end') break;
}
