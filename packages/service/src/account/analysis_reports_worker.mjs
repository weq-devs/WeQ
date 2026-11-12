import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { deflateSync, inflateSync } from 'node:zlib';

// 独立模块持有全部依赖，不将函数文本带离打包作用域。
mkdirSync(dirname(workerData.path), { recursive: true });
const db = new DatabaseSync(workerData.path);
db.exec(
  'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, meta TEXT NOT NULL, payload BLOB NOT NULL); CREATE TABLE IF NOT EXISTS result_versions (id TEXT NOT NULL, revision INTEGER NOT NULL, meta TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(id,revision))',
);
for (const row of db.prepare('SELECT id, meta FROM reports').all()) {
  const meta = JSON.parse(String(row.meta));
  if (meta.status === 'running') {
    meta.status = 'paused';
    db.prepare('UPDATE reports SET meta=? WHERE id=?').run(JSON.stringify(meta), String(row.id));
  }
}
parentPort.on('message', ({ id, method, input }) => {
  try {
    let value;
    if (method === 'put') {
      const { results, pending, ...meta } = input;
      const previous = db.prepare('SELECT meta FROM reports WHERE id=?').get(input.request.id);
      if (previous) meta.position = JSON.parse(String(previous.meta)).position;
      db.prepare(
        'INSERT INTO reports VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta,payload=excluded.payload',
      ).run(input.request.id, JSON.stringify(meta), deflateSync(serialize({ results, pending })));
      if (input.status === 'completed' && input.resultRevision > 0) {
        db.prepare('INSERT OR IGNORE INTO result_versions VALUES (?,?,?,?)').run(
          input.request.id,
          input.resultRevision,
          JSON.stringify({
            request: input.request,
            resultRevision: input.resultRevision,
            updatedAt: input.updatedAt,
          }),
          deflateSync(serialize(results)),
        );
      }
    } else if (method === 'versions') {
      value = db
        .prepare('SELECT meta FROM result_versions WHERE id=? ORDER BY revision DESC')
        .all(input.id)
        .map((row) => JSON.parse(String(row.meta)));
    } else if (method === 'version') {
      const row = db
        .prepare('SELECT meta,payload FROM result_versions WHERE id=? AND revision=?')
        .get(input.id, input.version);
      value = row
        ? { ...JSON.parse(String(row.meta)), results: deserialize(inflateSync(row.payload)) }
        : null;
    } else if (method === 'get') {
      const row = db.prepare('SELECT meta,payload FROM reports WHERE id=?').get(input.id);
      value = row
        ? { ...JSON.parse(String(row.meta)), ...deserialize(inflateSync(row.payload)) }
        : null;
    } else if (method === 'list') {
      value = db
        .prepare("SELECT meta FROM reports ORDER BY json_extract(meta,'$.updatedAt') DESC")
        .all()
        .map((row) => JSON.parse(String(row.meta)));
    } else if (method === 'position') {
      const row = db.prepare('SELECT meta FROM reports WHERE id=?').get(input.id);
      if (row) {
        const meta = { ...JSON.parse(String(row.meta)), position: input.position };
        db.prepare('UPDATE reports SET meta=? WHERE id=?').run(JSON.stringify(meta), input.id);
      }
    } else if (method === 'remove') {
      db.prepare('DELETE FROM result_versions WHERE id=?').run(input.id);
      db.prepare('DELETE FROM reports WHERE id=?').run(input.id);
    } else if (method === 'close') db.close();
    else throw new Error('未知报告存储操作');
    parentPort.postMessage({ id, value });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
