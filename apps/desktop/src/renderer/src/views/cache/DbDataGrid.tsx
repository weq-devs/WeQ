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
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  RefreshCw,
  X,
  Check,
  Search,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
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

/** Active sort: a column name + direction, or null for the table's natural order. */
interface SortState {
  column: string;
  dir: 'asc' | 'desc';
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
  // 搜索：`searchInput` 跟随输入框，防抖后落到 `search`（真正下发后端的词）。
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  // 排序：点表头在 无 → 升 → 降 → 无 间循环；null = 表的自然顺序。
  const [sort, setSort] = useState<SortState | null>(null);
  // Draft new-row inputs (column name → text); non-null when the insert row is open.
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  // Open BLOB lightbox: which row+column, its current hex, and the column name.
  const [blobView, setBlobView] = useState<{
    rowIndex: number;
    colIndex: number;
    hex: string;
    columnName: string;
  } | null>(null);

  // 输入框防抖 300ms 后才真正触发查询，避免每敲一个字符打一次后端。
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

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
          search: search || null,
          orderBy: sort?.column ?? null,
          orderDir: sort?.dir,
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
    [dbPath, table, search, sort],
  );

  // Reset to the first page whenever the query changes (table, search, sort).
  useEffect(() => {
    cursorStackRef.current = [];
    setCurrentCursor(null);
    setDraft(null);
    void load(null);
  }, [load]);

  // 点表头循环切换该列排序：无 → 升序 → 降序 → 无。
  function toggleSort(column: string): void {
    setSort((prev) => {
      if (prev?.column !== column) return { column, dir: 'asc' };
      if (prev.dir === 'asc') return { column, dir: 'desc' };
      return null;
    });
  }

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
          {search ? ' · 已筛选' : ''}
        </span>
        <span className="weq-cache-spacer" />
        <div className="weq-cache-search">
          <Search size={13} className="weq-cache-search-icon" />
          <input
            className="weq-cache-search-input"
            type="text"
            placeholder="搜索本表所有列…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput ? (
            <button
              type="button"
              className="weq-cache-search-clear"
              onClick={() => setSearchInput('')}
              title="清除搜索"
              aria-label="清除搜索"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
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
              {page.columns.map((c) => {
                const active = sort?.column === c.name;
                return (
                  <th
                    key={c.cid}
                    className={`weq-cache-grid-th is-sortable${active ? ' is-sorted' : ''}`}
                    title={`${c.type || '—'}${c.pk ? ' · PK' : ''} · 点击排序`}
                    onClick={() => toggleSort(c.name)}
                  >
                    <span className="weq-cache-th-inner">
                      <span className="weq-cache-th-label">{c.name}</span>
                      {c.pk ? <span className="weq-cache-pk">PK</span> : null}
                      {active ? (
                        sort?.dir === 'asc' ? (
                          <ArrowUp size={12} className="weq-cache-sort-caret" />
                        ) : (
                          <ArrowDown size={12} className="weq-cache-sort-caret" />
                        )
                      ) : null}
                    </span>
                  </th>
                );
              })}
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
                  {search ? '没有匹配的行' : '该表暂无数据'}
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
