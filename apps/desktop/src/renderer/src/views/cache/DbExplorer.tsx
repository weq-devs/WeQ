/**
 * SQLiteStudio-style database explorer (the 数据库 tab of the cache view).
 *
 * Left: a database picker (dropdown) + a schema-object tree (tables / views;
 * triggers intentionally excluded). Both the object tree and the outer resource
 * column can be collapsed to give the data grid near-full-screen room. Right: a
 * 数据 / SQL sub-tab pair over the selected object, plus an 编辑模式 toggle that
 * unlocks inline row editing and hand-written writes. Indices of the selected
 * table are surfaced on the SQL sub-tab (not mixed into the object tree).
 *
 * All data flows through `account.dbExplorer.*` (see @weq/service DbExplorer
 * Service). Nothing here decrypts or opens files directly.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Database,
  Table2,
  Eye,
  ChevronDown,
  AlertTriangle,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { DbObject } from '@weq/service';
import { trpc } from '../../trpc/client';
import { DbDataGrid } from './DbDataGrid';
import { SqlConsole } from './SqlConsole';

type SubTab = 'data' | 'sql';

interface AccountDbFile {
  name: string;
  path: string;
  bytes: number;
}

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function DbExplorer(): ReactElement {
  const databases = trpc.account.dbExplorer.listDatabases.useQuery();
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>('data');
  const [editable, setEditable] = useState(false);
  // 表选择列可收起，收起后腾出空间给数据表接近全屏查看。
  const [treeCollapsed, setTreeCollapsed] = useState(false);

  const dbList = useMemo<AccountDbFile[]>(
    () => ((databases.data ?? []) as AccountDbFile[]),
    [databases.data],
  );

  // Auto-select the first database once the list arrives.
  useEffect(() => {
    if (dbPath === null && dbList.length > 0) {
      setDbPath(dbList[0]!.path);
    }
  }, [dbList, dbPath]);

  const objects = trpc.account.dbExplorer.listObjects.useQuery(
    { dbPath: dbPath ?? '' },
    { enabled: Boolean(dbPath) },
  );

  // Reset object selection when the database changes.
  useEffect(() => {
    setSelectedTable(null);
  }, [dbPath]);

  // Auto-select the first table when a database's objects load.
  const objectList = useMemo<DbObject[]>(
    () => ((objects.data ?? []) as DbObject[]),
    [objects.data],
  );
  useEffect(() => {
    if (selectedTable === null && objectList.length > 0) {
      const firstTable = objectList.find((o) => o.type === 'table') ?? objectList[0];
      if (firstTable) setSelectedTable(firstTable.name);
    }
  }, [objectList, selectedTable]);

  const grouped = useMemo(() => {
    const tables = objectList.filter((o) => o.type === 'table');
    const views = objectList.filter((o) => o.type === 'view');
    return { tables, views };
  }, [objectList]);

  // 当前所选表/视图的索引——不再和表名混在左树里，改到 SQL 页展示。
  const selectedIndices = useMemo(
    () =>
      selectedTable
        ? objectList.filter((o) => o.type === 'index' && o.tableName === selectedTable)
        : [],
    [objectList, selectedTable],
  );

  const selectedDb = dbList.find((d) => d.path === dbPath) ?? null;

  return (
    <div className={`weq-cache-db${treeCollapsed ? ' is-tree-collapsed' : ''}`}>
      {/* 左树：选库 + 对象列表（可收起） */}
      {treeCollapsed ? (
        <div className="weq-cache-tree-rail">
          <button
            type="button"
            className="weq-cache-collapse-btn"
            onClick={() => setTreeCollapsed(false)}
            title="展开表列表"
            aria-label="展开表列表"
          >
            <PanelLeftOpen size={16} />
          </button>
        </div>
      ) : (
        <aside className="weq-cache-tree">
          <div className="weq-cache-dbpick">
            <button
              type="button"
              className="weq-cache-dbpick-btn"
              onClick={() => setPickerOpen((v) => !v)}
              disabled={dbList.length === 0}
            >
              <Database size={15} />
              <span className="weq-cache-dbpick-name" title={selectedDb?.name}>
                {selectedDb?.name ?? (databases.isLoading ? '加载中…' : '无数据库')}
              </span>
              <ChevronDown size={14} className="weq-cache-dbpick-caret" />
            </button>
            <button
              type="button"
              className="weq-cache-collapse-btn"
              onClick={() => setTreeCollapsed(true)}
              title="收起表列表"
              aria-label="收起表列表"
            >
              <PanelLeftClose size={16} />
            </button>
            {pickerOpen ? (
              <div className="weq-cache-dbpick-menu" role="listbox">
                {dbList.map((db) => (
                  <button
                    key={db.path}
                    type="button"
                    className={`weq-cache-dbpick-item${db.path === dbPath ? ' is-on' : ''}`}
                    onClick={() => {
                      setDbPath(db.path);
                      setPickerOpen(false);
                    }}
                    title={db.path}
                  >
                    <strong>{db.name}</strong>
                    <small>{fmtBytes(db.bytes)}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="weq-cache-tree-body">
            {objects.isLoading ? (
              <div className="weq-cache-tree-state">加载对象中…</div>
            ) : objectList.length === 0 ? (
              <div className="weq-cache-tree-state">该库无表 / 视图</div>
            ) : (
              <>
                <ObjectGroup
                  label="表"
                  icon={<Table2 size={14} />}
                  items={grouped.tables}
                  selected={selectedTable}
                  onSelect={setSelectedTable}
                />
                <ObjectGroup
                  label="视图"
                  icon={<Eye size={14} />}
                  items={grouped.views}
                  selected={selectedTable}
                  onSelect={setSelectedTable}
                />
              </>
            )}
          </div>
        </aside>
      )}

      {/* 右面板：数据 / SQL + 编辑模式 */}
      <section className="weq-cache-panel">
        <header className="weq-cache-panel-head">
          <div className="weq-cache-subtabs">
            <button
              type="button"
              className={`weq-cache-subtab${subTab === 'data' ? ' is-on' : ''}`}
              onClick={() => setSubTab('data')}
            >
              数据
            </button>
            <button
              type="button"
              className={`weq-cache-subtab${subTab === 'sql' ? ' is-on' : ''}`}
              onClick={() => setSubTab('sql')}
            >
              SQL
            </button>
          </div>
          <label className="weq-cache-editmode">
            <input
              type="checkbox"
              checked={editable}
              onChange={(e) => setEditable(e.target.checked)}
            />
            <span>编辑模式</span>
          </label>
        </header>

        {editable ? (
          <div className="weq-cache-warnbar">
            <AlertTriangle size={14} />
            编辑模式已开启：写操作会直接修改实时数据库，建议先关闭 QQ 并做好备份。
          </div>
        ) : null}

        <div className="weq-cache-panel-body">
          {!dbPath ? (
            <div className="weq-cache-grid-state">请选择数据库</div>
          ) : subTab === 'sql' ? (
            <SqlConsole
              dbPath={dbPath}
              editable={editable}
              tableName={selectedTable}
              indices={selectedIndices}
            />
          ) : selectedTable ? (
            <DbDataGrid
              key={`${dbPath}:${selectedTable}`}
              dbPath={dbPath}
              table={selectedTable}
              editable={editable}
            />
          ) : (
            <div className="weq-cache-grid-state">请选择左侧的表或视图</div>
          )}
        </div>
      </section>
    </div>
  );
}

function ObjectGroup({
  label,
  icon,
  items,
  selected,
  onSelect,
  muted = false,
}: {
  label: string;
  icon: ReactElement;
  items: DbObject[];
  selected: string | null;
  onSelect: (name: string) => void;
  muted?: boolean;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="weq-cache-tree-group">
      <div className="weq-cache-tree-grouphead">
        {icon}
        <span>{label}</span>
        <span className="weq-cache-tree-count">{items.length}</span>
      </div>
      {items.map((o) => (
        <button
          key={o.name}
          type="button"
          className={`weq-cache-tree-item${o.name === selected ? ' is-on' : ''}${
            muted ? ' is-muted' : ''
          }`}
          onClick={() => onSelect(o.name)}
          title={o.name}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}
