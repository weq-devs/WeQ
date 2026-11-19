/** 自包含 Worker：SQLite、聚合和空间回收均不占用业务线程。 */
export function performanceWorker(load: NodeJS.Require) {
  const { parentPort, workerData } = load(
    'node:worker_threads',
  ) as typeof import('node:worker_threads');
  const { DatabaseSync } = load('node:sqlite') as typeof import('node:sqlite');
  const { mkdirSync, statSync, openSync, writeSync, closeSync, unlinkSync } = load(
    'node:fs',
  ) as typeof import('node:fs');
  const { dirname } = load('node:path') as typeof import('node:path');
  type RecordRow = import('./types').MonitorRecord;
  type Settings = import('./types').MonitorSettings;
  type Range = import('./types').MonitorRange;
  const metrics = [
    'cpuPercent',
    'residentBytes',
    'heapBytes',
    'externalBytes',
    'eventLoopP95Ms',
  ] as const;
  mkdirSync(dirname(workerData.path), { recursive: true });
  const db = new DatabaseSync(workerData.path);
  db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=1048576;
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, at REAL NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_time ON records(at,id);
    CREATE TABLE IF NOT EXISTS points(record INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      at REAL NOT NULL, process TEXT NOT NULL, label TEXT NOT NULL, segment TEXT NOT NULL, interval_ms REAL NOT NULL,
      cpuPercent REAL, residentBytes REAL, heapBytes REAL, externalBytes REAL, eventLoopP95Ms REAL);
    CREATE INDEX IF NOT EXISTS points_time ON points(at,process,segment);
    PRAGMA foreign_keys=ON;`);
  const insert = db.prepare('INSERT INTO records(at,kind,data) VALUES(?,?,?)');
  const point = db.prepare('INSERT INTO points VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const bytes = () =>
    ['', '-wal', '-shm'].reduce((sum, suffix) => {
      try {
        return sum + statSync(workerData.path + suffix).size;
      } catch {
        return sum;
      }
    }, 0);
  const status = (): import('./types').MonitorStorageStatus => {
    const row = db
      .prepare('SELECT MIN(at) oldest,MAX(at) newest,COUNT(*) records FROM records')
      .get()!;
    return {
      oldest: row.oldest === null ? null : Number(row.oldest),
      newest: row.newest === null ? null : Number(row.newest),
      records: Number(row.records),
      bytes: bytes(),
    };
  };
  // 回收本身也会写 WAL，落盘后再按实际文件占用判断容量。
  const reclaim = () =>
    db.exec(
      'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(2048); PRAGMA wal_checkpoint(TRUNCATE);',
    );
  const capacityBudget = (settings: Settings) => settings.capacityMiB * 1024 * 1024 * 0.9;
  function previewPrune(settings: Settings): import('./types').MonitorPrunePreview {
    // 与删除前的非破坏性回收相同，不把 WAL 或空闲页误判成需要删除记录。
    reclaim();
    const storage = status();
    const cutoff = Date.now() - settings.retentionDays * 86400_000;
    const expiredRecords = Number(
      db.prepare('SELECT COUNT(*) n FROM records WHERE at<?').get(cutoff)!.n,
    );
    const capacityBudgetBytes = capacityBudget(settings);
    const capacityExceeded = storage.records > 0 && storage.bytes > capacityBudgetBytes;
    return {
      ...storage,
      cutoff,
      retentionDays: settings.retentionDays,
      capacityMiB: settings.capacityMiB,
      capacityBudgetBytes,
      expiredRecords,
      capacityExceeded,
      needsPrune: expiredRecords > 0 || capacityExceeded,
    };
  }
  async function prune(settings: Settings, confirmed = true) {
    const cutoff = Date.now() - settings.retentionDays * 86400_000;
    // 留出 WAL 和下一批写入空间；按实际文件大小回收，不只限制逻辑内容量。
    const budget = capacityBudget(settings);
    let removed = 0;
    for (;;) {
      const expired = Number(
        db.prepare('SELECT COUNT(*) n FROM records WHERE at<?').get(cutoff)!.n,
      );
      reclaim();
      if (!expired && bytes() <= budget) break;
      if (!confirmed && Number(db.prepare('SELECT COUNT(*) n FROM records').get()!.n) > 0)
        throw new Error('当前性能历史会被新保存策略删除，请重新确认后保存');
      const result = expired
        ? db
            .prepare(
              'DELETE FROM records WHERE id IN (SELECT id FROM records WHERE at<? ORDER BY at,id LIMIT 500)',
            )
            .run(cutoff)
        : db
            .prepare(
              'DELETE FROM records WHERE id IN (SELECT id FROM records ORDER BY at,id LIMIT 500)',
            )
            .run();
      removed += Number(result.changes);
      if (!result.changes) {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;');
        break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;');
    return removed;
  }
  async function dispatch(method: string, input: Record<string, unknown>): Promise<unknown> {
    if (method === 'settings')
      return db.prepare('SELECT data FROM settings WHERE id=1').get()?.data ?? null;
    if (method === 'configure-mode') {
      db.prepare('INSERT OR REPLACE INTO settings VALUES(1,?)').run(JSON.stringify(input.settings));
      return null;
    }
    if (method === 'configure') {
      const previous = db.prepare('SELECT data FROM settings WHERE id=1').get()?.data;
      if (input.confirmPrune === false && previewPrune(input.settings as Settings).needsPrune)
        throw new Error('当前性能历史会被新保存策略删除，请重新确认后保存');
      db.prepare('INSERT OR REPLACE INTO settings VALUES(1,?)').run(JSON.stringify(input.settings));
      try {
        // 写入配置也可能增加文件占用；在实际 DELETE 前再次检查。
        await prune(input.settings as Settings, input.confirmPrune !== false);
      } catch (error) {
        if (input.confirmPrune === false) {
          if (previous === undefined) db.prepare('DELETE FROM settings WHERE id=1').run();
          else db.prepare('INSERT OR REPLACE INTO settings VALUES(1,?)').run(previous);
        }
        throw error;
      }
      return null;
    }
    if (method === 'prune-preview') return previewPrune(input.settings as Settings);
    if (method === 'batch') {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const record of input.records as RecordRow[]) {
          const id = Number(
            insert.run(record.at, record.kind, JSON.stringify(record)).lastInsertRowid,
          );
          for (const proc of record.processes ?? [])
            point.run(
              id,
              record.at,
              proc.key,
              proc.label,
              record.segment,
              record.intervalMs,
              ...metrics.map((key) => proc.metrics[key]),
            );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      await prune(input.settings as Settings);
      return null;
    }
    if (method === 'prune') return prune(input.settings as Settings);
    if (method === 'status') return status();
    if (method === 'history') {
      const range = input as unknown as Range;
      const width = Math.max(1, (range.to - range.from) / range.buckets);
      const aggregates = metrics
        .flatMap((key) => [
          `MIN(${key}) ${key}_min`,
          `MAX(${key}) ${key}_max`,
          `AVG(${key}) ${key}_mean`,
        ])
        .join(',');
      const filter = "at>=? AND at<=? AND (?='' OR process=?) AND (?='' OR label=?)";
      const parameters = [
        range.from,
        range.to,
        range.process ?? '',
        range.process ?? '',
        range.processGroup ?? '',
        range.processGroup ?? '',
      ];
      // 先按真实采样合计，再计算时间桶统计，避免进程退出或峰值错位使汇总失真。
      const source = range.aggregate
        ? `(SELECT record,at,? process,? label,segment,MAX(interval_ms) interval_ms,
          ${metrics.map((key) => `${key === 'eventLoopP95Ms' ? 'MAX' : 'SUM'}(${key}) ${key}`).join(',')}
          FROM points WHERE ${filter} GROUP BY record,segment)`
        : `(SELECT * FROM points WHERE ${filter})`;
      const label = range.processGroup || '全部进程';
      const rows = db
        .prepare(`SELECT process,label,segment,CAST((at-?)/? AS INTEGER) bucket,
        MIN(at) firstAt,MAX(at) lastAt,MAX(record) id,COUNT(*) count,MAX(interval_ms) intervalMs,${aggregates}
        FROM ${source} GROUP BY process,segment,bucket ORDER BY firstAt LIMIT 8001`)
        .all(
          range.from,
          width,
          ...(range.aggregate ? [`group:${label}`, label] : []),
          ...parameters,
        );
      const points = rows.slice(0, 8000).map((row) => ({
        process: row.process,
        label: row.label,
        segment: row.segment,
        start: range.from + Number(row.bucket) * width,
        end: Math.min(range.to, range.from + (Number(row.bucket) + 1) * width),
        firstAt: row.firstAt,
        lastAt: row.lastAt,
        id: row.id,
        count: row.count,
        intervalMs: row.intervalMs,
        metrics: Object.fromEntries(
          metrics.map((key) => [
            key,
            { min: row[`${key}_min`], max: row[`${key}_max`], mean: row[`${key}_mean`] },
          ]),
        ),
      }));
      const events = db
        .prepare(
          "SELECT id,at,json_extract(data,'$.event') event,json_extract(data,'$.session') session,json_extract(data,'$.reason') reason FROM records WHERE kind='event' AND at>=? AND at<=? ORDER BY at LIMIT 1001",
        )
        .all(range.from, range.to);
      return {
        points,
        processGroups: db
          .prepare(
            'SELECT DISTINCT label FROM points WHERE at>=? AND at<=? ORDER BY label LIMIT 128',
          )
          .all(range.from, range.to)
          .map((row) => String(row.label)),
        events: events.slice(0, 1000),
        eventLimitReached: events.length > 1000,
        pointLimitReached: rows.length > 8000,
      };
    }
    if (method === 'detail') {
      const row = db.prepare('SELECT data FROM records WHERE id=?').get(Number(input.id));
      return row ? JSON.parse(String(row.data)) : null;
    }
    if (method === 'export') {
      const rows = db
        .prepare('SELECT id,data FROM records WHERE at>=? AND at<=? AND id>? ORDER BY id LIMIT 200')
        .all(Number(input.from), Number(input.to), Number(input.after ?? 0));
      return {
        rows: rows.map((row) => String(row.data)),
        next: rows.length === 200 ? Number(rows.at(-1)!.id) : null,
      };
    }
    if (method === 'export-file') {
      // 同一串行命令内读取及落盘，清空／清理不会穿插进导出；内存只保留一行或聚合结果。
      const path = String(input.path),
        range = input.range as Range,
        started = Date.now();
      const fd = openSync(path, 'wx', 0o600);
      try {
        const write = (text: string) => {
          if (Date.now() - started > 25_000)
            throw new Error('导出超过 25 秒，请缩小时间范围后重试');
          const bytes = Buffer.from(text);
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
        };
        if (input.format === 'jsonl') {
          const query = db.prepare(
            'SELECT id,at,data FROM records WHERE at>=? AND at<=? AND (at>? OR (at=? AND id>?)) ORDER BY at,id LIMIT 200',
          );
          let cursorAt = range.from,
            cursorId = 0;
          for (;;) {
            const rows = query.all(range.from, range.to, cursorAt, cursorAt, cursorId);
            for (const row of rows) write(`${String(row.data)}\n`);
            if (rows.length < 200) break;
            cursorAt = Number(rows.at(-1)!.at);
            cursorId = Number(rows.at(-1)!.id);
          }
        } else {
          const history = (await dispatch(
            'history',
            range as unknown as Record<string, unknown>,
          )) as import('./types').MonitorHistory;
          if (history.pointLimitReached)
            throw new Error('图表聚合点过多，请缩小时间范围或选择单一进程后导出 CSV');
          write('start,end,process,segment,count,metric,min,max,mean\n');
          const cell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
          for (const point of history.points)
            for (const [metric, values] of Object.entries(point.metrics))
              write(
                `${[new Date(point.start).toISOString(), new Date(point.end).toISOString(), point.process, point.segment, point.count, metric, values.min, values.max, values.mean].map(cell).join(',')}\n`,
              );
        }
        closeSync(fd);
        return null;
      } catch (error) {
        closeSync(fd);
        unlinkSync(path);
        throw error;
      }
    }
    if (method === 'clear') {
      db.exec(
        'DELETE FROM points; DELETE FROM records; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;',
      );
      return null;
    }
    if (method === 'close') {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      return null;
    }
    throw new Error('未知性能监视操作');
  }
  // 清理中让出 Worker，不允许下一条命令穿插事务或清空操作。
  let serial = Promise.resolve();
  parentPort!.on(
    'message',
    (message: { id: number; method: string; input: Record<string, unknown> }) => {
      serial = serial.then(async () => {
        try {
          parentPort!.postMessage({
            id: message.id,
            value: await dispatch(message.method, message.input),
          });
        } catch (error) {
          parentPort!.postMessage({
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  );
}
