/**
 * Hand-written SQL console for one database.
 *
 * A themed monospace editor + 执行 button that calls `account.dbExplorer.runSql`.
 * SELECT/WITH/PRAGMA/EXPLAIN come back as a column+row result table (capped at
 * 1000 rows server-side; a truncation note shows when hit); INSERT/UPDATE/
 * DELETE/DDL report the affected-row count.
 *
 * Writes hit QQ's live database, so the run button is gated behind the parent's
 * 编辑模式 for anything that isn't a read statement — we detect that client-side
 * and refuse to send a write while read-only, matching the grid's guard.
 *
 * When a table is selected, its indices are listed above the editor (moved here
 * from the object tree); clicking one loads its `CREATE INDEX` DDL into the
 * editor for inspection.
 */

import { useState, type ReactElement, type KeyboardEvent } from 'react';
import { Play, AlertTriangle, KeyRound } from 'lucide-react';
import type { DbObject, QueryResult } from '@weq/service';
import { client } from '../../trpc/client';
import { cellText, cellKind } from './cellFormat';
import { BlobHexModal } from './BlobHexModal';

const READ_RE = /^\s*(select|with|pragma|explain)\b/i;

export function SqlConsole({
  dbPath,
  editable,
  tableName = null,
  indices = [],
}: {
  dbPath: string;
  editable: boolean;
  /** 当前左树所选表/视图名，用于「本表索引」标题。 */
  tableName?: string | null;
  /** 当前所选表的索引对象，从左树迁移到此处按表查看。 */
  indices?: DbObject[];
}): ReactElement {
  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isRead = READ_RE.test(sql);
  const blockedWrite = !isRead && sql.trim() !== '' && !editable;

  async function run(): Promise<void> {
    const trimmed = sql.trim();
    if (!trimmed || running) return;
    if (blockedWrite) {
      setError('这是写操作（非 SELECT）。请先在右上角开启「编辑模式」后再执行。');
      setResult(null);
      setNotice(null);
      return;
    }
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await client.account.dbExplorer.runSql.mutate({ dbPath, sql: trimmed });
      setResult(res);
      if (res.kind === 'write') {
        setNotice(`执行成功，影响 ${res.rowsAffected} 行。`);
      } else if (res.truncated) {
        setNotice(`结果较大，仅显示前 ${res.rows.length} 行。`);
      } else {
        setNotice(`返回 ${res.rows.length} 行。`);
      }
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Ctrl/Cmd + Enter runs the statement.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void run();
    }
  }

  return (
    <div className="weq-cache-sql">
      {indices.length > 0 ? (
        <div className="weq-cache-sql-indices">
          <div className="weq-cache-sql-indices-head">
            <KeyRound size={13} />
            <span>
              「{tableName}」的索引
              <em className="weq-cache-sql-indices-count">{indices.length}</em>
            </span>
          </div>
          <div className="weq-cache-sql-indices-list">
            {indices.map((idx) => (
              <button
                key={idx.name}
                type="button"
                className="weq-cache-sql-index"
                title={idx.sql ? `点击载入定义：\n${idx.sql}` : idx.name}
                disabled={!idx.sql}
                onClick={() => {
                  if (idx.sql) setSql(`${idx.sql};`);
                }}
              >
                {idx.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="weq-cache-sql-editor">
        <textarea
          className="weq-cache-sql-input"
          placeholder="输入 SQL，Ctrl/⌘ + Enter 执行&#10;例：SELECT * FROM sqlite_master LIMIT 20;"
          spellCheck={false}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="weq-cache-sql-bar">
          {blockedWrite ? (
            <span className="weq-cache-sql-warn">
              <AlertTriangle size={13} /> 写操作需先开启编辑模式
            </span>
          ) : (
            <span className="weq-cache-sql-hint">
              {isRead ? '读查询' : sql.trim() ? '写操作' : 'Ctrl/⌘ + Enter 执行'}
            </span>
          )}
          <button
            type="button"
            className="weq-cache-btn is-primary"
            onClick={() => void run()}
            disabled={running || sql.trim() === ''}
          >
            <Play size={14} />
            {running ? '执行中…' : '执行'}
          </button>
        </div>
      </div>

      <div className="weq-cache-sql-out">
        {error ? (
          <div className="weq-cache-sql-error">{error}</div>
        ) : result && result.kind === 'rows' ? (
          <>
            {notice ? <div className="weq-cache-sql-notice">{notice}</div> : null}
            <ResultTable result={result} />
          </>
        ) : result && result.kind === 'write' ? (
          <div className="weq-cache-sql-notice is-ok">{notice}</div>
        ) : (
          <div className="weq-cache-sql-placeholder">执行结果将在此显示</div>
        )}
      </div>
    </div>
  );
}

function ResultTable({ result }: { result: QueryResult }): ReactElement {
  // Open BLOB lightbox (read-only for hand-written query results).
  const [blobView, setBlobView] = useState<{ hex: string; columnName: string } | null>(null);

  if (result.columns.length === 0) {
    return <div className="weq-cache-sql-placeholder">（无列）</div>;
  }
  return (
    <div className="weq-cache-grid-scroll">
      <table className="weq-cache-grid">
        <thead>
          <tr>
            <th className="weq-cache-grid-rownum">#</th>
            {result.columns.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
              <th key={`${c}:${i}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, ri) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            <tr key={ri}>
              <td className="weq-cache-grid-rownum">{ri + 1}</td>
              {row.map((cell, ci) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                <td key={ci} className={`weq-cache-cell is-${cellKind(cell)}`}>
                  {cell === null ? (
                    <span className="weq-cache-null">NULL</span>
                  ) : cell !== null && typeof cell === 'object' && cell.t === 'blob' ? (
                    <button
                      type="button"
                      className="weq-cache-blob-btn"
                      title="点击查看二进制"
                      onClick={() =>
                        setBlobView({ hex: cell.hex, columnName: result.columns[ci] ?? '' })
                      }
                    >
                      {cellText(cell)}
                    </button>
                  ) : (
                    cellText(cell)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {blobView ? (
        <BlobHexModal
          hex={blobView.hex}
          columnName={blobView.columnName}
          editable={false}
          onClose={() => setBlobView(null)}
        />
      ) : null}
    </div>
  );
}
