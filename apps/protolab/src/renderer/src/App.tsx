import { useEffect, useState, useMemo } from 'react';
import { raw as codecRaw } from '@weq/codec';
import type { CellSample, ColumnRow, TableRow } from '../../shared/ipc';
import { Tree } from './components/Tree';
import { useSchemas } from './hooks/useSchemas';
import {
  Database,
  Table as TableIcon,
  Columns,
  Beaker,
  Search,
  FolderOpen,
  Key,
  AlertCircle,
  FileCode,
  Layout,
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  Terminal,
  X,
  Copy,
  Binary,
  ArrowUpDown
} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from './lib/utils';

const { decode, SchemaIndex, annotate } = codecRaw;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Convert plain decode tree to AnnotatedField[] with all `unknown` matches. */
function toBareAnnotated(fields: ReturnType<typeof codecRaw.decode>): import('@weq/codec/raw').AnnotatedField[] {
  return fields.map((f) => {
    const nested = f.guesses.find((g) => g.kind === 'len-nested');
    return {
      raw: f,
      ...(nested && nested.kind === 'len-nested'
        ? { children: toBareAnnotated(nested.value) }
        : {}),
      match: { kind: 'unknown' as const },
    };
  });
}

export default function App() {
  const schemas = useSchemas();

  const [dbPath, setDbPath] = useState('C:\\Users\\17078\\Documents\\Tencent Files\\1707889225\\nt_qq\\nt_db\\nt_msg.db');
  const [key, setKey] = useState('^;<kXZ;RI[@]yTD<');
  const [opened, setOpened] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [tables, setTables] = useState<TableRow[]>([]);
  const [table, setTable] = useState<string>('');

  const [columns, setColumns] = useState<ColumnRow[]>([]);
  const [column, setColumn] = useState<string>('');

  const [samples, setSamples] = useState<CellSample[]>([]);
  const [selected, setSelected] = useState<CellSample | null>(null);
  const [schemaName, setSchemaName] = useState<string>('');
  const [showRawHex, setShowRawHex] = useState(false);
  const [sampleOrder, setSampleOrder] = useState<'ASC' | 'DESC'>('DESC');
  const [hasMoreSamples, setHasMoreSamples] = useState(true);
  const [rowidSearch, setRowidSearch] = useState('');

  const [filter, setFilter] = useState('');

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') || 'dark';
  });

  useEffect(() => {
    localStorage.setItem('theme', theme);
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  async function openDb() {
    setErr(null);
    try {
      await window.protolab.openDb({ dbPath, key });
      const t = await window.protolab.listTables({ dbPath, key });
      setTables(t);
      setOpened(true);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    if (!opened || !table) return;
    setColumn('');
    setSamples([]);
    setSelected(null);
    window.protolab
      .listColumns({ dbPath, key, table })
      .then(setColumns)
      .catch((e: unknown) => setErr(String(e)));
  }, [opened, table, dbPath, key]);

  useEffect(() => {
    if (!opened || !table || !column) return;
    setSelected(null);
    setSamples([]);
    setHasMoreSamples(true);
    window.protolab
      .sampleColumn({ dbPath, key, table, column, limit: 50, offset: 0, order: sampleOrder })
      .then((data) => {
        setSamples(data);
        setHasMoreSamples(data.length === 50);
      })
      .catch((e: unknown) => setErr(String(e)));
  }, [opened, table, column, dbPath, key, sampleOrder]);

  function refreshSamples() {
    if (!opened || !table || !column) return;
    setSelected(null);
    setSamples([]);
    setHasMoreSamples(true);
    window.protolab
      .sampleColumn({ dbPath, key, table, column, limit: 50, offset: 0, order: sampleOrder })
      .then((data) => {
        setSamples(data);
        setHasMoreSamples(data.length === 50);
      })
      .catch((e: unknown) => setErr(String(e)));
  }

  function loadMoreSamples() {
    if (!opened || !table || !column || !hasMoreSamples) return;
    window.protolab
      .sampleColumn({ dbPath, key, table, column, limit: 50, offset: samples.length, order: sampleOrder })
      .then((data) => {
        setSamples((prev) => [...prev, ...data]);
        setHasMoreSamples(data.length === 50);
      })
      .catch((e: unknown) => setErr(String(e)));
  }

  function searchByRowid() {
    if (!opened || !table || !column) return;
    const rowid = rowidSearch.trim();
    if (!rowid) {
      refreshSamples();
      return;
    }
    setErr(null);
    setSelected(null);
    window.protolab
      .sampleColumn({ dbPath, key, table, column, rowid })
      .then((data) => {
        setSamples(data);
        setHasMoreSamples(false);
        if (data.length === 0) {
          setErr(`rowid ${rowid} 未找到(该列为空或行不存在)`);
        } else {
          setSelected(data[0]!);
        }
      })
      .catch((e: unknown) => setErr(String(e)));
  }

  const annotated = useMemo(() => {
    if (!selected) return null;
    try {
      const bytes = hexToBytes(selected.bytesHex);
      const tree = decode(bytes);
      const schema = schemas.find((s) => s.qualifiedName === schemaName);
      if (!schema) return { tree, annotated: null };
      const index = new SchemaIndex(schema.schema, schemaName);
      return { tree, annotated: annotate(tree, index) };
    } catch (e) {
      console.error('Decode failed', e);
      return null;
    }
  }, [selected, schemaName, schemas]);

  const filteredTables = tables.filter(t => t.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="h-screen flex flex-col bg-background text-foreground font-sans selection:bg-primary/20">
      {/* Header */}
      <header className="h-11 border-b border-border bg-card flex items-center justify-between px-3 shrink-0 z-20">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center">
            <Beaker className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-sm font-semibold text-foreground">ProtoLab</span>
          <span className="text-xs text-muted">Inspector</span>
        </div>

        <div className="flex items-center gap-2 flex-1 max-w-3xl px-6">
          <div className="relative flex-1 group">
            <FolderOpen className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted group-focus-within:text-primary transition-colors" />
            <input
              className="w-full bg-accent border border-border rounded-md pl-8 pr-3 py-1.5 text-xs font-mono outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/15 transition-all placeholder:text-muted/50"
              placeholder="Database path..."
              value={dbPath}
              onChange={(e) => setDbPath(e.target.value)}
            />
          </div>
          <div className="relative w-48 group">
            <Key className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted group-focus-within:text-primary transition-colors" />
            <input
              type="password"
              className="w-full bg-accent border border-border rounded-md pl-8 pr-3 py-1.5 text-xs font-mono outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/15 transition-all placeholder:text-muted/50"
              placeholder="Key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          <button
            type="button"
            className={cn(
              "px-4 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap",
              opened
                ? "bg-primary/8 text-primary border border-primary/15"
                : "bg-primary hover:bg-primary/90 text-white active:scale-[0.97]"
            )}
            onClick={openDb}
          >
            {opened ? "Connected" : "Connect"}
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="p-1.5 rounded-md hover:bg-accent text-muted hover:text-foreground transition-colors"
            title="Toggle theme"
          >
            {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
          <span className="text-xs text-muted tabular-nums">{schemas.length} schemas</span>
        </div>
      </header>

      {err && (
        <div className="bg-red-500/8 border-b border-red-500/15 px-3 py-1.5 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r border-border flex flex-col shrink-0 bg-card/50 h-full">
          <div className="p-2 shrink-0">
            <div className="relative group">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted group-focus-within:text-primary transition-colors" />
              <input
                className="w-full bg-accent border border-border rounded-md pl-8 pr-3 py-1.5 text-xs outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/15 transition-all placeholder:text-muted/50"
                placeholder="Filter tables..."
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
            </div>
          </div>

          <div className="flex-1 flex flex-col min-h-0">

            {/* Tables */}
            <div className="flex-1 flex flex-col min-h-0 px-2">
              <div className="flex items-center justify-between px-1.5 mb-1 shrink-0">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted flex items-center gap-1.5">
                  <Database className="w-3 h-3" /> Tables
                </span>
                <span className="text-[10px] font-mono text-muted/50">{filteredTables.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-px custom-scrollbar">
                {filteredTables.map((t) => (
                  <button
                    key={t.name}
                    className={cn(
                      "w-full text-left px-2 py-1.5 rounded-md text-xs font-mono transition-colors truncate flex items-center gap-2 shrink-0",
                      table === t.name
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted hover:bg-accent hover:text-foreground"
                    )}
                    onClick={() => setTable(t.name)}
                  >
                    <TableIcon className={cn("w-3 h-3 shrink-0", table === t.name ? "text-primary" : "text-muted/40")} />
                    {t.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="h-px bg-border mx-2 my-1 shrink-0" />

            {/* Columns */}
            <div className="flex-1 flex flex-col min-h-0 px-2">
              <div className="flex items-center gap-1.5 px-1.5 mb-1 shrink-0">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted flex items-center gap-1.5">
                  <Columns className="w-3 h-3" /> Columns
                </span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-px custom-scrollbar">
                {!table && <div className="h-full flex items-center justify-center"><p className="text-xs text-muted/40 italic">Select a table</p></div>}
                {columns.map((c) => (
                  <button
                    key={c.name}
                    className={cn(
                      "w-full text-left px-2 py-1.5 rounded-md text-xs font-mono transition-colors truncate flex items-center justify-between shrink-0",
                      column === c.name
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted hover:bg-accent hover:text-foreground"
                    )}
                    onClick={() => setColumn(c.name)}
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="text-[10px] text-muted/30 uppercase ml-1.5 shrink-0">{c.type}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="h-px bg-border mx-2 my-1 shrink-0" />

            {/* Samples */}
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between px-3.5 mb-1 shrink-0">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted flex items-center gap-1.5">
                  <FileCode className="w-3 h-3" /> Samples
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setSampleOrder(order => order === 'ASC' ? 'DESC' : 'ASC')}
                    className="p-1 rounded hover:bg-accent text-muted hover:text-primary transition-colors disabled:opacity-30"
                    disabled={!column}
                    title={`Order: ${sampleOrder} (click to toggle)`}
                  >
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                  <button
                    onClick={refreshSamples}
                    className="p-1 rounded hover:bg-accent text-muted hover:text-primary transition-colors disabled:opacity-30"
                    disabled={!column}
                    title="Refresh"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="px-2 pb-1.5 shrink-0">
                <div className="relative group">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted group-focus-within:text-primary transition-colors" />
                  <input
                    className="w-full bg-accent border border-border rounded-md pl-7 pr-3 py-1 text-[11px] font-mono outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/15 transition-all placeholder:text-muted/50 disabled:opacity-40"
                    placeholder="Go to rowid..."
                    value={rowidSearch}
                    disabled={!column}
                    onChange={(e) => setRowidSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') searchByRowid();
                    }}
                  />
                </div>
              </div>
              <div
                onScroll={(e) => {
                  const target = e.currentTarget;
                  if (target.scrollHeight - target.scrollTop - target.clientHeight < 50 && hasMoreSamples) {
                    loadMoreSamples();
                  }
                }}
              >
                {!column && <div className="h-full flex items-center justify-center"><p className="text-xs text-muted/40 italic">Select a column</p></div>}
                {samples.map((s) => (
                  <button
                    key={s.rowid}
                    className={cn(
                      "w-full text-left px-2.5 py-1.5 rounded-md text-xs font-mono transition-colors shrink-0 flex items-center justify-between",
                      selected?.rowid === s.rowid
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted hover:bg-accent hover:text-foreground"
                    )}
                    onClick={() => setSelected(s)}
                  >
                    <span className="font-medium">#{s.rowid}</span>
                    <span className="text-[10px] text-muted/40">{s.byteLength}B</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-h-0 bg-background relative">
          <div className="h-9 border-b border-border bg-card/80 backdrop-blur-sm flex items-center px-4 gap-4 shrink-0 sticky top-0 z-10">
            <div className="flex items-center gap-3 flex-1">
              <Layout className="w-3.5 h-3.5 text-muted" />
              <span className="text-[10px] font-medium text-muted uppercase tracking-wider">Schema</span>
              <select
                className="bg-accent border border-border rounded-md px-2.5 py-1 text-xs outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/15 transition-all font-mono min-w-[240px]"
                value={schemaName}
                onChange={(e) => setSchemaName(e.target.value)}
              >
                <option value="">(None - Raw)</option>
                {schemas.map((s) => (
                  <option key={s.qualifiedName} value={s.qualifiedName}>{s.qualifiedName}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="text-[10px] text-muted">HMR</span>
            </div>
          </div>

          <div className="flex-1 overflow-hidden flex flex-col items-center">
            {!selected ? (
              <div className="flex-1 flex flex-col items-center justify-center text-muted gap-3 opacity-30">
                <Monitor className="w-10 h-10" />
                <div className="text-center">
                  <p className="text-sm font-medium">Ready to Decode</p>
                  <p className="text-xs mt-0.5 opacity-60">Select a sample to begin</p>
                </div>
              </div>
            ) : (
              <div className="flex-1 w-full overflow-y-auto p-4 custom-scrollbar">
                <div className="max-w-6xl mx-auto space-y-3">
                  {/* Info bar */}
                  <div className="flex items-center justify-between bg-card border border-border rounded-lg px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <FileCode className="w-4 h-4 text-primary" />
                      <span className="text-sm font-medium text-foreground">
                        Row <span className="text-primary">#{selected.rowid}</span>
                      </span>
                      <span className="text-xs text-muted/40">|</span>
                      <span className="text-xs text-muted font-mono">{table}.{column}</span>
                      <span className="text-xs text-muted/40">|</span>
                      <span className="text-xs text-muted font-mono">{selected.byteLength}B</span>
                    </div>
                    <button
                      onClick={() => setShowRawHex(true)}
                      className="px-3 py-1.5 rounded-md bg-muted/10 hover:bg-primary/10 text-muted hover:text-primary border border-border hover:border-primary/30 transition-all text-xs font-medium flex items-center gap-1.5"
                    >
                      <FileCode className="w-3 h-3" />
                      View Raw
                    </button>
                  </div>

                  {/* Tree panel */}
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="border-b border-border bg-accent/50 px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full bg-muted/20" />
                          <div className="w-2.5 h-2.5 rounded-full bg-muted/20" />
                          <div className="w-2.5 h-2.5 rounded-full bg-muted/20" />
                        </div>
                        <span className="text-[10px] font-medium text-muted uppercase tracking-wider">Protocol Buffer Tree</span>
                      </div>
                    </div>
                    <div className="p-4 overflow-x-auto min-h-[400px]">
                      {annotated ? (
                        <Tree fields={annotated.annotated ?? toBareAnnotated(annotated.tree)} hasSchema={!!schemaName} />
                      ) : (
                        <div className="flex items-center justify-center flex-col gap-2 text-muted p-8">
                          <AlertCircle className="w-5 h-5 opacity-30" />
                          <p className="text-xs">Decoding failed or returned no fields</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      {selected && (
        <RawHexModal
          open={showRawHex}
          onOpenChange={setShowRawHex}
          sample={selected}
          tableName={table}
          columnName={column}
        />
      )}
    </div>
  );
}

function RawHexModal({ open, onOpenChange, sample, tableName, columnName }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sample: CellSample;
  tableName: string;
  columnName: string;
}) {
  const bytes = useMemo(() => hexToBytes(sample.bytesHex), [sample.bytesHex]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-background/70 backdrop-blur-sm z-[100] animate-in fade-in duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl max-h-[85vh] bg-card border border-border rounded-xl shadow-xl z-[101] flex flex-col overflow-hidden animate-in fade-in zoom-in-[0.98] duration-200">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <Terminal className="w-4 h-4 text-primary" />
              <div>
                <Dialog.Title className="text-sm font-semibold">Raw Hexdump</Dialog.Title>
                <Dialog.Description className="text-[11px] text-muted mt-0.5 font-mono">
                  {tableName}.{columnName} · Row #{sample.rowid} · {sample.byteLength}B
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close className="p-1.5 rounded-md hover:bg-accent transition-colors">
              <X className="w-4 h-4 text-muted" />
            </Dialog.Close>
          </div>
          <div className="flex-1 p-4 overflow-hidden">
            <div className="h-full bg-accent rounded-lg border border-border p-4 overflow-y-auto custom-scrollbar">
              <div className="font-mono text-xs leading-6 space-y-px">
                {Array.from({ length: Math.ceil(bytes.length / 16) }).map((_, rowIndex) => (
                  <div key={rowIndex} className="flex gap-4 group/row">
                    <span className="text-muted/25 shrink-0 w-12">{(rowIndex * 16).toString(16).padStart(8, '0')}</span>
                    <span className="text-primary/70 group-hover/row:text-primary transition-colors flex-1">
                      {Array.from(bytes.slice(rowIndex * 16, rowIndex * 16 + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(sample.bytesHex)}
              className="mt-3 w-full bg-primary hover:bg-primary/90 text-white py-2 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 active:scale-[0.98]"
            >
              <Copy className="w-3 h-3" /> Copy hex
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
