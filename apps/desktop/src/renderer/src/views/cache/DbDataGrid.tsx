/**
 * Data tab for one table/view: a themed grid with keyset pagination and, when
 * 编辑模式 is on, inline cell editing + row delete + row insert.
 *
 * Row identity comes from the backend's per-row {@link RowKey} (rowid for
 * ordinary tables, primary key otherwise) — we never guess a WHERE clause on
 * the client. BLOB cells are read-only (shown as a hex preview). Views and
 * tables without a usable key render read-only regardless of 编辑模式.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ChevronLeft, ChevronRight, Plus, Trash2, RefreshCw, X, Check } from 'lucide-react';
import type { DbCell, DbColumn, RowKey, TableRowsResult } from '@weq/service';
import { client } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { cellText, cellKind, cellEditText, isCellEditable, textToInput } from './cellFormat';
import { BlobHexModal } from './BlobHexModal';

interface PageState {
  columns: DbColumn[];
  rows: DbCell[][];
  keys: RowKey[];
  hasRowid: boolean;
  nextCursor: string | null;
}

/** One editing target: which row (by index) + column. */
interface EditTarget {
  rowIndex: number;
  colIndex: number;
}

export function DbDataGrid({
  dbPath,
  table,
  editable,
}: {
  dbPath: string;
  table: string;
  editable: boolean;
}): ReactElement {
  const dialog = useAppDialog();
  const [page, setPage] = useState<PageState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Cursor stack for backward paging: each entry is the cursor that produced the
  // page BEFORE the current one. `null` sentinel = the very first page.
  const cursorStackRef = useRef<Array<string | null>>([]);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  // Draft new-row inputs (column name → text); non-null when the insert row is open.
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  // Open BLOB lightbox: which row+column, its current hex, and the column name.
  const [blobView, setBlobView] = useState<{
    rowIndex: number;
    colIndex: number;
    hex: string;
    columnName: string;
  } | null>(null);

  const load = useCallback(
    async (cursor: string | null): Promise<void> => {
      setLoading(true);
      setError(null);
      setEdit(null);
      try {
        const res: TableRowsResult = await client.account.dbExplorer.getRows.query({
          dbPath,
          table,
          cursor,
          limit: 200,
        });
        setPage({
          columns: res.columns,
          rows: res.rows,
          keys: res.keys,
          hasRowid: res.hasRowid,
          nextCursor: res.nextCursor,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPage(null);
      } finally {
        setLoading(false);
      }
    },
    [dbPath, table],
  );

  // Reset to the first page whenever the target table changes.
  useEffect(() => {
    cursorStackRef.current = [];
    setCurrentCursor(null);
    setDraft(null);
    void load(null);
  }, [load]);

  function nextPage(): void {
    if (!page?.nextCursor) return;
    cursorStackRef.current.push(currentCursor);
    setCurrentCursor(page.nextCursor);
    void load(page.nextCursor);
  }

  function prevPage(): void {
    if (cursorStackRef.current.length === 0) return;
    const prev = cursorStackRef.current.pop() ?? null;
    setCurrentCursor(prev);
    void load(prev);
  }

  function refresh(): void {
    void load(currentCursor);
  }

  const canEditRows = editable && page?.hasRowid !== false;

  function beginEdit(rowIndex: number, colIndex: number): void {
    if (!canEditRows || !page) return;
    const cell = page.rows[rowIndex]?.[colIndex];
    if (cell === undefined || !isCellEditable(cell)) return;
    setEdit({ rowIndex, colIndex });
    setEditValue(cellEditText(cell));
  }

  async function commitEdit(): Promise<void> {
    if (!edit || !page || saving) return;
    const column = page.columns[edit.colIndex];
    const rowKey = page.keys[edit.rowIndex];
    if (!column || !rowKey) {
      setEdit(null);
      return;
    }
    setSaving(true);
    try {
      await client.account.dbExplorer.updateCell.mutate({
        dbPath,
        table,
        rowKey,
        column: column.name,
        value: textToInput(editValue, column),
      });
      setEdit(null);
      dialog.success('已保存', `${column.name} 已更新`);
      await load(currentCursor);
    } catch (e) {
      dialog.error('更新失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveBlob(rowIndex: number, colIndex: number, hex: string): Promise<void> {
    if (!page) return;
    const column = page.columns[colIndex];
    const rowKey = page.keys[rowIndex];
    if (!column || !rowKey) throw new Error('无法定位该行');
    await client.account.dbExplorer.updateCell.mutate({
      dbPath,
      table,
      rowKey,
      column: column.name,
      value: { t: 'blob', hex },
    });
    dialog.success('已保存', `${column.name} 已更新`);
    await load(currentCursor);
  }

  async function deleteRow(rowIndex: number): Promise<void> {
    if (!page) return;
    const rowKey = page.keys[rowIndex];
    if (!rowKey) return;
    const ok = await dialog.confirm(
      '删除该行',
      '此操作将直接从实时数据库删除该行，无法撤销。建议先确保 QQ 已关闭。确认删除？',
      { okLabel: '删除', cancelLabel: '取消', tone: 'warning' },
    );
    if (!ok) return;
    try {
      await client.account.dbExplorer.deleteRow.mutate({ dbPath, table, rowKey });
      dialog.success('已删除', '该行已从数据库删除');
      await load(currentCursor);
    } catch (e) {
      dialog.error('删除失败', e instanceof Error ? e.message : String(e));
    }
  }

  async function commitInsert(): Promise<void> {
    if (!draft || !page || saving) return;
    // Only send columns the user actually typed into; blank = take the default.
    const values = page.columns
      .filter((c) => (draft[c.name] ?? '') !== '')
      .map((c) => ({ name: c.name, value: textToInput(draft[c.name] ?? '', c) }));
    setSaving(true);
    try {
      await client.account.dbExplorer.insertRow.mutate({ dbPath, table, values });
      setDraft(null);
      dialog.success('已新增', '新行已写入数据库');
      await load(currentCursor);
    } catch (e) {
      dialog.error('新增失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !page) {
    return <div className="weq-cache-grid-state">加载数据中…</div>;
  }
  if (error) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }
  if (!page) {
    return <div className="weq-cache-grid-state">无数据</div>;
  }

  const pageIndex = cursorStackRef.current.length + 1;

  return (
    <div className="weq-cache-data">
      <div className="weq-cache-data-bar">
        <span className="weq-cache-data-name" title={table}>
          {table}
        </span>
        <span className="weq-cache-data-meta">
          {page.rows.length} 行
          {page.hasRowid ? '' : ' · 无 rowid（只读）'}
        </span>
        <span className="weq-cache-spacer" />
        {canEditRows ? (
          <button
            type="button"
            className="weq-cache-tool"
            onClick={() => setDraft(draft ? null : {})}
            disabled={saving}
          >
            <Plus size={14} />
            {draft ? '取消新增' : '新增行'}
          </button>
        ) : null}
        <button type="button" className="weq-cache-tool" onClick={refresh} title="刷新">
          <RefreshCw size={14} />
          刷新
        </button>
      </div>

      <div className="weq-cache-grid-scroll">
        <table className="weq-cache-grid">
          <thead>
            <tr>
              <th className="weq-cache-grid-rownum">#</th>
              {page.columns.map((c) => (
                <th key={c.cid} title={`${c.type || '—'}${c.pk ? ' · PK' : ''}`}>
                  {c.name}
                  {c.pk ? <span className="weq-cache-pk">PK</span> : null}
                </th>
              ))}
              {canEditRows ? <th className="weq-cache-grid-actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {/* Draft insert row pinned to the top when open. */}
            {draft ? (
              <tr className="weq-cache-draft-row">
                <td className="weq-cache-grid-rownum">＋</td>
                {page.columns.map((c) => (
                  <td key={c.cid} className="weq-cache-cell">
                    <input
                      className="weq-cache-cell-input"
                      placeholder={c.pk ? '(默认)' : c.notNull ? '(必填)' : '(默认)'}
                      value={draft[c.name] ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({ ...(d ?? {}), [c.name]: e.target.value }))
                      }
                    />
                  </td>
                ))}
                <td className="weq-cache-grid-actions">
                  <button
                    type="button"
                    className="weq-cache-row-btn is-ok"
                    onClick={() => void commitInsert()}
                    disabled={saving}
                    title="保存新行"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    className="weq-cache-row-btn"
                    onClick={() => setDraft(null)}
                    title="取消"
                  >
                    <X size={14} />
                  </button>
                </td>
              </tr>
            ) : null}

            {page.rows.map((row, ri) => (
              <tr key={ri}>
                <td className="weq-cache-grid-rownum">{ri + 1}</td>
                {row.map((cell, ci) => {
                  const editing = edit?.rowIndex === ri && edit?.colIndex === ci;
                  const editableCell = canEditRows && isCellEditable(cell);
                  const isBlob = cellKind(cell) === 'blob';
                  return (
                    <td
                      key={ci}
                      className={`weq-cache-cell is-${cellKind(cell)}${
                        editableCell ? ' is-editable' : ''
                      }`}
                      onDoubleClick={() => beginEdit(ri, ci)}
                      title={editableCell ? '双击编辑' : isBlob ? '点击查看 / 编辑二进制' : undefined}
                    >
                      {editing ? (
                        <input
                          className="weq-cache-cell-input"
                          autoFocus
                          value={editValue}
                          disabled={saving}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => void commitEdit()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void commitEdit();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setEdit(null);
                            }
                          }}
                        />
                      ) : cell === null ? (
                        <span className="weq-cache-null">NULL</span>
                      ) : isBlob && cell !== null && typeof cell === 'object' && cell.t === 'blob' ? (
                        <button
                          type="button"
                          className="weq-cache-blob-btn"
                          onClick={() =>
                            setBlobView({
                              rowIndex: ri,
                              colIndex: ci,
                              hex: cell.hex,
                              columnName: page.columns[ci]?.name ?? '',
                            })
                          }
                        >
                          {cellText(cell)}
                        </button>
                      ) : (
                        cellText(cell)
                      )}
                    </td>
                  );
                })}
                {canEditRows ? (
                  <td className="weq-cache-grid-actions">
                    <button
                      type="button"
                      className="weq-cache-row-btn is-danger"
                      onClick={() => void deleteRow(ri)}
                      title="删除该行"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
            {page.rows.length === 0 && !draft ? (
              <tr>
                <td
                  className="weq-cache-grid-empty"
                  colSpan={page.columns.length + 1 + (canEditRows ? 1 : 0)}
                >
                  该表暂无数据
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="weq-cache-pager">
        <button
          type="button"
          className="weq-cache-tool"
          onClick={prevPage}
          disabled={cursorStackRef.current.length === 0 || loading}
        >
          <ChevronLeft size={14} />
          上一页
        </button>
        <span className="weq-cache-pager-num">第 {pageIndex} 页</span>
        <button
          type="button"
          className="weq-cache-tool"
          onClick={nextPage}
          disabled={!page.nextCursor || loading}
        >
          下一页
          <ChevronRight size={14} />
        </button>
      </div>

      {blobView ? (
        <BlobHexModal
          hex={blobView.hex}
          columnName={blobView.columnName}
          editable={canEditRows}
          onClose={() => setBlobView(null)}
          onSave={
            canEditRows
              ? (hex) => saveBlob(blobView.rowIndex, blobView.colIndex, hex)
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
