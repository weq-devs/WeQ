/** 自包含函数供 worker 执行；不捕获主线程闭包，桌面和 Web 共用同一实现。 */
export function contactHistoryWorker(
  encode: (value: unknown) => unknown,
  load: NodeRequire,
  projectFields: typeof import('./contact_field_history').projectContactHistoryFields,
) {
  const { parentPort, workerData } = load(
    'node:worker_threads',
  ) as typeof import('node:worker_threads');
  const { DatabaseSync } = load('node:sqlite') as typeof import('node:sqlite');
  const { createHash } = load('node:crypto') as typeof import('node:crypto');
  const { brotliCompressSync, brotliDecompressSync, constants } = load(
    'node:zlib',
  ) as typeof import('node:zlib');
  const { mkdirSync, statSync } = load('node:fs') as typeof import('node:fs');
  const { dirname } = load('node:path') as typeof import('node:path');
  mkdirSync(dirname(workerData.path), { recursive: true });
  const db = new DatabaseSync(workerData.path);
  db.exec('PRAGMA busy_timeout=1000');
  db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    PRAGMA journal_size_limit=8388608; PRAGMA wal_autocheckpoint=256;
    CREATE TABLE IF NOT EXISTS content(hash TEXT PRIMARY KEY, codec INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS aliases(alias TEXT PRIMARY KEY, entity TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS versions(id INTEGER PRIMARY KEY, entity TEXT NOT NULL, category TEXT NOT NULL,
      source TEXT NOT NULL, scope TEXT NOT NULL, completeness TEXT NOT NULL, hash TEXT NOT NULL REFERENCES content(hash),
      first_at REAL NOT NULL, last_at REAL NOT NULL, effective_hash TEXT REFERENCES content(hash));
    CREATE INDEX IF NOT EXISTS history_entity ON versions(entity,first_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS history_stream ON versions(entity,category,source,scope,first_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS projections(key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS migrations(path TEXT PRIMARY KEY, hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS history_entity_id ON versions(entity,id);
    CREATE TABLE IF NOT EXISTS field_progress(entity TEXT NOT NULL,member_uid TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(entity,member_uid));
    CREATE TABLE IF NOT EXISTS field_changed(entity TEXT NOT NULL,member_uid TEXT NOT NULL,field TEXT NOT NULL,PRIMARY KEY(entity,member_uid,field));
    CREATE TABLE IF NOT EXISTS field_versions(entity TEXT NOT NULL,member_uid TEXT NOT NULL,field TEXT NOT NULL,stream TEXT NOT NULL,
      version_id INTEGER NOT NULL,first_at REAL NOT NULL,last_at REAL NOT NULL,value TEXT NOT NULL,
      PRIMARY KEY(entity,member_uid,field,version_id));
    CREATE INDEX IF NOT EXISTS field_stream ON field_versions(entity,member_uid,field,stream,version_id DESC);
    CREATE INDEX IF NOT EXISTS field_progress_member ON field_progress(member_uid) WHERE member_uid!='';
    CREATE INDEX IF NOT EXISTS field_versions_member ON field_versions(member_uid) WHERE member_uid!='';
    CREATE INDEX IF NOT EXISTS field_changed_member ON field_changed(member_uid) WHERE member_uid!='';`);
  db.exec(
    'CREATE TABLE IF NOT EXISTS field_index_meta(key TEXT PRIMARY KEY,version INTEGER NOT NULL)',
  );
  if (
    Number(
      db.prepare("SELECT version FROM field_index_meta WHERE key='format'").get()?.version ?? 0,
    ) !== 3
  ) {
    db.exec(
      "BEGIN IMMEDIATE; DELETE FROM field_progress; DELETE FROM field_versions; DELETE FROM field_changed; INSERT OR REPLACE INTO field_index_meta VALUES('format',3); COMMIT;",
    );
  }
  if (
    !db
      .prepare('PRAGMA table_info(versions)')
      .all()
      .some((column) => column.name === 'effective_hash')
  )
    db.exec('ALTER TABLE versions ADD COLUMN effective_hash TEXT REFERENCES content(hash)');
  const putContent = db.prepare('INSERT OR IGNORE INTO content VALUES(?,?,?)');
  const getContent = db.prepare('SELECT codec,data FROM content WHERE hash=?');
  const recentRoots = new Map<string, string>();
  const knownLinks = new Map<string, string>();
  const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');
  function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(',')}}`;
  }
  function blob(value: unknown) {
    const text = canonical(value),
      hash = hashOf(text);
    if (!getContent.get(hash)) {
      const raw = Buffer.from(text);
      const zipped =
        raw.length > 256
          ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
          : raw;
      putContent.run(
        hash,
        zipped.length < raw.length ? 1 : 0,
        zipped.length < raw.length ? zipped : raw,
      );
    }
    return hash;
  }
  // 数组条目各存一份；名单每次仅增加变化成员及压缩后的引用清单。
  function pack(value: unknown): unknown {
    if (Array.isArray(value)) return { a: value.map((item) => blob(pack(item))) };
    if (value && typeof value === 'object')
      return {
        o: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pack(item)])),
      };
    return { v: value };
  }
  function unpack(value: unknown): unknown {
    const node = value as { a?: string[]; o?: Record<string, unknown>; v?: unknown };
    if (node.a) return node.a.map((hash) => unpack(readBlob(hash)));
    if (node.o)
      return Object.fromEntries(Object.entries(node.o).map(([key, item]) => [key, unpack(item)]));
    return node.v;
  }
  function readBlob(hash: string): unknown {
    const row = getContent.get(hash);
    if (!row) throw new Error('历史内容缺失');
    const bytes = Buffer.from(row.data as Uint8Array);
    return JSON.parse((row.codec === 1 ? brotliDecompressSync(bytes) : bytes).toString('utf8'));
  }
  function merge(previous: unknown, next: unknown): unknown {
    if (
      !previous ||
      !next ||
      typeof previous !== 'object' ||
      typeof next !== 'object' ||
      Array.isArray(previous) ||
      Array.isArray(next)
    )
      return next;
    const old = previous as Record<string, unknown>,
      value = next as Record<string, unknown>;
    if (Object.hasOwn(value, '$type') || Object.hasOwn(old, '$type')) return next;
    const result = { ...old };
    for (const [key, field] of Object.entries(value)) {
      if (field && typeof field === 'object' && Reflect.get(field, '$type') === 'undefined')
        continue;
      Object.defineProperty(result, key, {
        value: merge(old[key], field),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  function entity(key: string) {
    return String(db.prepare('SELECT entity FROM aliases WHERE alias=?').get(key)?.entity ?? key);
  }
  function rememberLink(uid: string, uin: string) {
    knownLinks.set(uid, uin);
    if (knownLinks.size > 20000) knownLinks.delete(knownLinks.keys().next().value!);
  }
  function link(uid: string, uin: string) {
    if (!/^u_[\w-]+$/.test(uid) || !/^\d+$/.test(uin) || /^0+$/.test(uin)) return;
    if (knownLinks.get(uid) === uin) return;
    const a = entity(`friend:${uid}`),
      b = entity(`friend:${uin}`);
    if (
      a === b &&
      db.prepare('SELECT entity FROM aliases WHERE alias=?').get(`friend:${uid}`)?.entity === a &&
      db.prepare('SELECT entity FROM aliases WHERE alias=?').get(`friend:${uin}`)?.entity === a
    ) {
      rememberLink(uid, uin);
      return;
    }
    if (a !== b) {
      db.prepare('DELETE FROM field_progress WHERE entity IN (?,?)').run(a, b);
      db.prepare('DELETE FROM field_versions WHERE entity IN (?,?)').run(a, b);
      db.prepare('DELETE FROM field_changed WHERE entity IN (?,?)').run(a, b);
      db.prepare("DELETE FROM field_progress WHERE member_uid=? AND member_uid!=''").run(uid);
      db.prepare("DELETE FROM field_versions WHERE member_uid=? AND member_uid!=''").run(uid);
      db.prepare("DELETE FROM field_changed WHERE member_uid=? AND member_uid!=''").run(uid);
      db.prepare('UPDATE versions SET entity=? WHERE entity=?').run(a, b);
      db.prepare('UPDATE aliases SET entity=? WHERE entity=?').run(a, b);
    }
    db.prepare('INSERT OR REPLACE INTO aliases VALUES(?,?)').run(`friend:${uin}`, a);
    db.prepare('INSERT OR REPLACE INTO aliases VALUES(?,?)').run(`friend:${uid}`, a);
    rememberLink(uid, uin);
  }
  function observe(input: Record<string, unknown>) {
    const key = entity(String(input.entity));
    const category = String(input.category),
      source = String(input.source),
      scope = String(input.scope ?? '');
    const completeness = String(input.completeness ?? 'partial');
    const rawHash = hashOf(canonical(input.value));
    let hash = recentRoots.get(rawHash);
    if (!hash) {
      hash = blob(pack(input.value));
      recentRoots.set(rawHash, hash);
      if (recentRoots.size > 256) recentRoots.delete(recentRoots.keys().next().value!);
    }
    const at = Number(input.at ?? Date.now());
    if (source === 'legacy') {
      const imported = db
        .prepare(
          'SELECT id FROM versions WHERE entity=? AND category=? AND source=? AND scope=? AND hash=? AND first_at=?',
        )
        .get(key, category, source, scope, hash, at);
      if (imported) return imported.id;
    }
    const prev = db
      .prepare(
        'SELECT id,hash,effective_hash,completeness,first_at FROM versions WHERE entity=? AND category=? AND source=? AND scope=? AND first_at<=? ORDER BY first_at DESC,id DESC LIMIT 1',
      )
      .get(key, category, source, scope, at);
    if (prev?.hash === hash && prev.completeness === completeness && at >= Number(prev.first_at)) {
      db.prepare('UPDATE versions SET last_at=MAX(last_at,?) WHERE id=?').run(at, prev.id!);
      return prev.id;
    }
    const previousValue = prev ? unpack(readBlob(String(prev.effective_hash ?? prev.hash))) : null;
    let effective =
      completeness === 'partial' && prev ? blob(pack(merge(previousValue, input.value))) : hash;
    const id = Number(
      db
        .prepare(
          'INSERT INTO versions(entity,category,source,scope,completeness,hash,first_at,last_at,effective_hash) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(key, category, source, scope, completeness, hash, at, at, effective).lastInsertRowid,
    );
    // 失败重试可能补入较早观察；按时间重建后继投影，不改变各次原始回包。
    let cursorAt = at,
      cursorId = id;
    successors: while (true) {
      const followingRows = db
        .prepare(
          'SELECT id,hash,effective_hash,completeness,first_at FROM versions WHERE entity=? AND category=? AND source=? AND scope=? AND (first_at>? OR (first_at=? AND id>?)) ORDER BY first_at,id LIMIT 128',
        )
        .all(key, category, source, scope, cursorAt, cursorAt, cursorId);
      for (const following of followingRows) {
        if (following.completeness !== 'partial') break successors;
        effective = blob(
          pack(merge(unpack(readBlob(effective)), unpack(readBlob(String(following.hash))))),
        );
        if (following.effective_hash === effective) break successors;
        db.prepare('UPDATE versions SET effective_hash=? WHERE id=?').run(effective, following.id!);
        cursorAt = Number(following.first_at);
        cursorId = Number(following.id);
      }
      if (followingRows.length < 128) break;
    }
    return id;
  }
  function version(id: number, key: string) {
    const row = db.prepare('SELECT * FROM versions WHERE id=? AND entity=?').get(id, entity(key));
    if (!row) throw new Error('历史版本不存在或不属于该对象');
    return {
      ...row,
      value: unpack(readBlob(String(row.effective_hash ?? row.hash))),
      ...(row.effective_hash && row.effective_hash !== row.hash
        ? { observedValue: unpack(readBlob(String(row.hash))) }
        : {}),
    };
  }
  function dispatch(method: string, input: Record<string, unknown>): unknown {
    if (method === 'fieldSummary') {
      const key = entity(String(input.entity));
      const uid = String(input.memberUid ?? '');
      const peer = uid ? entity(`friend:${uid}`) : key;
      const cursor = Number(
        db
          .prepare('SELECT cursor FROM field_progress WHERE entity=? AND member_uid=?')
          .get(key, uid)?.cursor ?? 0,
      );
      const rows = db
        .prepare(
          'SELECT id,category,source,scope,hash,first_at,last_at FROM versions WHERE entity IN (?,?) AND id>? ORDER BY id LIMIT 100',
        )
        .all(key, peer, cursor);
      const previous = db.prepare(
        'SELECT version_id,value FROM field_versions WHERE entity=? AND member_uid=? AND field=? AND stream=? ORDER BY version_id DESC LIMIT 1',
      );
      const insert = db.prepare('INSERT INTO field_versions VALUES(?,?,?,?,?,?,?,?)');
      const touch = db.prepare(
        'UPDATE field_versions SET last_at=? WHERE entity=? AND member_uid=? AND field=? AND version_id=?',
      );
      const changed = db.prepare('INSERT OR IGNORE INTO field_changed VALUES(?,?,?)');
      for (const row of rows) {
        const stream = JSON.stringify([row.category, row.source, uid ? '' : row.scope]);
        for (const [field, value] of projectFields(
          String(row.category),
          () => unpack(readBlob(String(row.hash))),
          uid,
          key.startsWith('group:') ? key.slice(6) : '',
        )) {
          const old = previous.get(key, uid, field, stream);
          const text = canonical(
            old && ['birthday', 'region'].includes(field)
              ? merge(JSON.parse(String(old.value)), value)
              : value,
          );
          if (old?.value === text)
            touch.run(Number(row.last_at), key, uid, field, Number(old.version_id));
          else {
            insert.run(
              key,
              uid,
              field,
              stream,
              Number(row.id),
              Number(row.first_at),
              Number(row.last_at),
              text,
            );
            if (old) changed.run(key, uid, field);
          }
        }
      }
      const next = Number(rows.at(-1)?.id ?? cursor);
      db.prepare('INSERT OR REPLACE INTO field_progress VALUES(?,?,?)').run(key, uid, next);
      const fields = db
        .prepare('SELECT field FROM field_changed WHERE entity=? AND member_uid=? ORDER BY field')
        .all(key, uid)
        .map((row) => String(row.field));
      return {
        fields,
        pending: Boolean(
          db
            .prepare('SELECT 1 FROM versions WHERE entity IN (?,?) AND id>? LIMIT 1')
            .get(key, peer, next),
        ),
      };
    }
    if (method === 'fieldVersions') {
      const key = entity(String(input.entity));
      const uid = String(input.memberUid ?? '');
      const limit = Number(input.limit ?? 30);
      const before = Number(
        db
          .prepare(
            'SELECT first_at FROM field_versions WHERE entity=? AND member_uid=? AND field=? AND version_id=?',
          )
          .get(key, uid, String(input.field), Number(input.before ?? 0))?.first_at ??
          Number.MAX_VALUE,
      );
      const rows = db
        .prepare(
          'SELECT version_id AS id,first_at,last_at,value FROM field_versions WHERE entity=? AND member_uid=? AND field=? AND (first_at<? OR (first_at=? AND version_id<?)) ORDER BY first_at DESC,version_id DESC LIMIT ?',
        )
        .all(
          key,
          uid,
          String(input.field),
          before,
          before,
          Number(input.before ?? Number.MAX_SAFE_INTEGER),
          limit + 1,
        );
      return {
        rows: rows.slice(0, limit).map((row) => ({ ...row, value: JSON.parse(String(row.value)) })),
        nextBefore: rows.length > limit ? Number(rows[limit - 1]?.id) : null,
      };
    }
    if (method === 'importMetrics') {
      for (const [key, fields] of Object.entries(input.rows as Record<string, unknown>)) {
        if (
          !/^(friend|group):[\w-]+$/.test(key) ||
          !fields ||
          typeof fields !== 'object' ||
          Array.isArray(fields)
        )
          throw new Error('旧指标对象格式错误');
        for (const cell of Object.values(fields)) {
          if (
            !cell ||
            typeof cell !== 'object' ||
            Array.isArray(cell) ||
            !Number.isFinite(Reflect.get(cell, 'attemptedAt')) ||
            !['ready', 'failed', 'stale'].includes(Reflect.get(cell, 'state'))
          )
            throw new Error('旧指标字段格式错误');
        }
      }
      dispatch('projection', { rows: input.rows, insertOnly: true });
      for (const [key, fields] of Object.entries(
        input.rows as Record<string, Record<string, { updatedAt?: number; attemptedAt?: number }>>,
      )) {
        for (const [metric, cell] of Object.entries(fields)) {
          const value = encode(cell);
          const id = Number(
            observe({
              entity: key,
              category: `metric.${metric}`,
              source: 'legacy',
              completeness: 'complete',
              value,
              at: cell.updatedAt ?? cell.attemptedAt ?? input.at,
            }),
          );
          const restored = version(id, key);
          if (canonical(restored.observedValue ?? restored.value) !== canonical(value))
            throw new Error('旧指标迁移校验失败');
        }
      }
      return null;
    }
    if (method === 'batch') {
      for (const pair of (input.links ?? []) as Array<{ uid: string; uin: string }>)
        link(pair.uid, pair.uin);
      return (input.observations as Record<string, unknown>[]).map((observation) =>
        observe(input.raw ? { ...observation, value: encode(observation.value) } : observation),
      );
    }
    if (method === 'observe') return observe(input);
    if (method === 'link') return link(String(input.uid), String(input.uin));
    if (method === 'list') {
      const before = Number(
        db
          .prepare('SELECT first_at FROM versions WHERE id=? AND entity=?')
          .get(Number(input.before ?? 0), entity(String(input.entity)))?.first_at ??
          Number.MAX_VALUE,
      );
      const rows = db
        .prepare(`SELECT id,category,source,scope,completeness,first_at,last_at FROM versions
        WHERE entity=? AND (first_at<? OR (first_at=? AND id<?)) AND (?='' OR category=?) ORDER BY first_at DESC,id DESC LIMIT ?`)
        .all(
          entity(String(input.entity)),
          before,
          before,
          Number(input.before ?? Number.MAX_SAFE_INTEGER),
          String(input.category ?? ''),
          String(input.category ?? ''),
          Number(input.limit ?? 30) + 1,
        );
      const more = rows.length > Number(input.limit ?? 30);
      if (more) rows.pop();
      return { rows, nextBefore: more ? rows.at(-1)?.id : null };
    }
    if (method === 'version') return version(Number(input.id), String(input.entity));
    if (method === 'latest') {
      const row = db
        .prepare(
          "SELECT id FROM versions WHERE entity=? AND category=? AND source=? AND scope=? AND (?='' OR completeness=?) ORDER BY first_at DESC,id DESC LIMIT 1",
        )
        .get(
          entity(String(input.entity)),
          String(input.category),
          String(input.source),
          String(input.scope ?? ''),
          String(input.completeness ?? ''),
          String(input.completeness ?? ''),
        );
      return row ? version(Number(row.id), String(input.entity)) : null;
    }
    if (method === 'groups')
      return db
        .prepare(
          "SELECT DISTINCT entity FROM versions WHERE category='members' AND completeness='complete' AND entity LIKE 'group:%'",
        )
        .all()
        .map((row) => String(row.entity).slice(6));
    if (method === 'categories')
      return db
        .prepare('SELECT DISTINCT category FROM versions WHERE entity=? ORDER BY category')
        .all(entity(String(input.entity)))
        .map((row) => String(row.category));
    if (method === 'previous') {
      const row = db
        .prepare('SELECT * FROM versions WHERE id=? AND entity=?')
        .get(Number(input.id), entity(String(input.entity)));
      if (!row) throw new Error('历史版本不存在');
      const prev = db
        .prepare(
          'SELECT id FROM versions WHERE entity=? AND category=? AND source=? AND scope=? AND (first_at<? OR (first_at=? AND id<?)) ORDER BY first_at DESC,id DESC LIMIT 1',
        )
        .get(
          row.entity!,
          row.category!,
          row.source!,
          row.scope!,
          row.first_at!,
          row.first_at!,
          row.id!,
        );
      return prev ? version(Number(prev.id), String(input.entity)) : null;
    }
    if (method === 'projection') {
      const get = db.prepare('SELECT data FROM projections WHERE key=?');
      for (const [key, value] of Object.entries(input.rows as Record<string, unknown>)) {
        if (input.insertOnly && get.get(key)) continue;
        const row = encode(value) as Record<string, Record<string, unknown>>;
        for (const cell of Object.values(row)) {
          if (
            cell &&
            typeof cell === 'object' &&
            Object.hasOwn(cell, 'value') &&
            canonical(cell.value).length > 96
          )
            cell.value = { $historyValue: blob(pack(cell.value)) };
        }
        const data = canonical(row);
        if (get.get(key)?.data !== data)
          db.prepare('INSERT OR REPLACE INTO projections VALUES(?,?)').run(key, data);
      }
      if (input.replace) {
        const keys = new Set(Object.keys(input.rows as object));
        for (const row of db.prepare('SELECT key FROM projections').all())
          if (!keys.has(String(row.key)))
            db.prepare('DELETE FROM projections WHERE key=?').run(row.key!);
      }
      return null;
    }
    if (method === 'projections')
      return Object.fromEntries(
        db
          .prepare('SELECT key,data FROM projections')
          .all()
          .map((row) => {
            const data = JSON.parse(String(row.data));
            for (const cell of Object.values(data) as Array<Record<string, unknown>>) {
              if (
                cell?.value &&
                typeof cell.value === 'object' &&
                Reflect.has(cell.value, '$historyValue')
              )
                cell.value = unpack(readBlob(String(Reflect.get(cell.value, '$historyValue'))));
            }
            return [row.key, data];
          }),
      );
    if (method === 'migrated')
      return (
        db.prepare('SELECT hash FROM migrations WHERE path=?').get(String(input.path))?.hash ===
        input.hash
      );
    if (method === 'migration')
      return db
        .prepare('INSERT OR REPLACE INTO migrations VALUES(?,?)')
        .run(String(input.path), String(input.hash)).changes;
    if (method === 'status') {
      const size = (suffix: string) => {
        try {
          return statSync(workerData.path + suffix).size;
        } catch {
          return 0;
        }
      };
      return {
        versions: db.prepare('SELECT COUNT(*) AS n FROM versions').get()!.n,
        contents: db.prepare('SELECT COUNT(*) AS n FROM content').get()!.n,
        bytes: size('') + size('-wal') + size('-shm'),
      };
    }
    if (method === 'flush') {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return null;
    }
    throw new Error('未知历史查询');
  }
  parentPort!.on(
    'message',
    (message: { id: number; method: string; input: Record<string, unknown> }) => {
      try {
        if (message.method === 'close') {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          db.exec('PRAGMA incremental_vacuum(128)');
          db.close();
          parentPort!.postMessage({ id: message.id, value: null });
          parentPort!.close();
          return;
        }
        const transactional = [
          'observe',
          'batch',
          'link',
          'projection',
          'migration',
          'importMetrics',
          'fieldSummary',
        ].includes(message.method);
        if (transactional) db.exec('BEGIN IMMEDIATE');
        try {
          const value = dispatch(message.method, message.input);
          if (transactional) db.exec('COMMIT');
          parentPort!.postMessage({ id: message.id, value });
        } catch (error) {
          if (transactional) db.exec('ROLLBACK');
          recentRoots.clear();
          knownLinks.clear();
          throw error;
        }
      } catch (error) {
        parentPort!.postMessage({
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
