import { useState, useMemo } from 'react';
import type { AnnotatedField, Guess } from '@weq/codec/raw';
import { motion, AnimatePresence } from 'framer-motion';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ChevronRight,
  Hash,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Clock,
  Type,
  Binary,
  Braces,
  X,
  Copy,
  Terminal,
  SearchCode,
  ShieldCheck
} from 'lucide-react';
import { cn } from '../lib/utils';
import { ElementWire } from '@weq/codec/proto/msg/element';
import { validateElement } from '../lib/elementValidator';

const TAG_TO_FIELD = Object.entries(ElementWire).reduce((acc, [name, field]) => {
  if (field && typeof field === 'object' && 'no' in field) {
    acc[field.no as number] = name;
  }
  return acc;
}, {} as Record<number, string>);

export function Tree({ fields, hasSchema }: { fields: AnnotatedField[]; hasSchema?: boolean }) {
  const validation = useMemo(() => validateElement(fields), [fields]);

  return (
    <div className="font-mono text-xs leading-relaxed select-none">
      {validation && (
        <div className="mb-4 p-3 rounded-lg border bg-card">
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">
              Element Validation: {validation.elementName}
            </span>
          </div>
          {!validation.hasSchema && (
            <div className="text-xs text-muted">Schema not implemented yet</div>
          )}
          {validation.hasSchema && validation.missingRequired.length === 0 && validation.unexpectedFields.length === 0 && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-3 h-3" />
              All required fields present, no unexpected fields
            </div>
          )}
          {validation.missingRequired.length > 0 && (
            <div className="text-xs text-red-600 dark:text-red-400 mt-1">
              Missing required: {validation.missingRequired.join(', ')}
            </div>
          )}
          {validation.unexpectedFields.length > 0 && (
            <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              Unexpected tags: {validation.unexpectedFields.join(', ')}
            </div>
          )}
        </div>
      )}
      {fields.map((f, i) => (
        <TreeNode key={`${f.raw.start}-${f.raw.tag}-${i}`} node={f} depth={0} hasSchema={hasSchema} />
      ))}
    </div>
  );
}

function TreeNode({ node, depth, hasSchema }: { node: AnnotatedField; depth: number; hasSchema?: boolean }) {
  const [open, setOpen] = useState(true);
  const [guessIdx, setGuessIdx] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const guess = node.raw.guesses[guessIdx] ?? node.raw.guesses[0];
  const hasChildren = guess?.kind === 'len-nested' && !!node.children?.length;

  const badge = (() => {
    if (node.match.kind === 'matched') {
      return {
        label: node.match.info.name,
        color: 'text-primary',
        bg: 'bg-primary/8',
        icon: CheckCircle2,
      };
    }
    if (node.match.kind === 'type-mismatch') {
      return {
        label: node.match.info.name,
        color: 'text-amber-600 dark:text-amber-400',
        bg: 'bg-amber-500/8',
        icon: AlertTriangle,
      };
    }
    if (!hasSchema) return null;
    return {
      label: '(unknown)',
      color: 'text-muted/50',
      bg: 'bg-muted/6',
      icon: HelpCircle,
    };
  })();

  return (
    <div className="group/node">
      <div
        className={cn(
          "flex items-center gap-2.5 px-2 py-1 rounded-md transition-colors cursor-pointer relative",
          "hover:bg-accent/60",
          open && hasChildren && "bg-accent/30"
        )}
        style={{ marginLeft: `${depth * 16}px` }}
        onClick={() => hasChildren && setOpen((o) => !o)}
      >
        {depth > 0 && (
          <div
            className="absolute left-[-8px] top-0 bottom-0 w-px bg-border/40"
          />
        )}

        <div className="flex items-center gap-1.5 min-w-[180px] shrink-0">
          <div className="w-4 flex justify-center">
            {hasChildren ? (
              <motion.div animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }}>
                <ChevronRight className="w-3 h-3 text-muted/50" />
              </motion.div>
            ) : (
              <div className="w-1 h-1 rounded-full bg-border" />
            )}
          </div>
          {(() => {
            const fieldName = TAG_TO_FIELD[node.raw.tag];
            const tagColor = node.match.kind === 'matched'
              ? 'text-emerald-600 dark:text-emerald-400'
              : node.match.kind === 'type-mismatch'
              ? 'text-red-600 dark:text-red-400'
              : 'text-muted/70';
            return fieldName ? (
              <span className={cn("flex items-center gap-1 font-medium text-[11px]", tagColor)}>
                <span className="truncate max-w-[120px]">{fieldName}</span>
                <span className="text-muted/40">({node.raw.tag})</span>
              </span>
            ) : (
              <span className={cn("flex items-center gap-0.5 font-medium", tagColor)}>
                <Hash className="w-3 h-3 opacity-30" />
                {node.raw.tag}
              </span>
            );
          })()}
        </div>

        <div className="flex items-center min-w-[70px] shrink-0">
          <span className={cn(
            "text-[10px] px-1.5 py-px rounded font-medium",
            node.raw.wireType === 2
              ? "bg-primary/8 text-primary"
              : "bg-muted/8 text-muted/70"
          )}>
            {wireLabel(node.raw.wireType)}
          </span>
        </div>

        {badge && (
          <div className={cn(
            "flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[11px] min-w-[120px] shrink-0",
            badge.bg,
            badge.color
          )}>
            <badge.icon className="w-3 h-3" />
            <span className="truncate max-w-[110px] font-medium">{badge.label}</span>
          </div>
        )}

        <div
          className="flex-1 flex items-center gap-2 overflow-hidden"
          onClick={(e) => {
            if (!hasChildren) {
              e.stopPropagation();
              setShowDetail(true);
            }
          }}
        >
          <span className={cn(
            "truncate transition-colors",
            !hasChildren ? "text-foreground hover:text-primary cursor-pointer" : "text-foreground/70"
          )}>
            {guess ? renderGuess(guess) : <span className="text-muted/30 italic text-[10px]">empty</span>}
          </span>

          {node.raw.guesses.length > 1 && (
            <button
              type="button"
              className="p-1 rounded hover:bg-accent text-muted hover:text-primary transition-colors shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                setGuessIdx((i) => (i + 1) % node.raw.guesses.length);
              }}
              title={`Cycle (${guessIdx + 1}/${node.raw.guesses.length})`}
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-2 text-[10px] text-muted/25 opacity-0 group-hover/node:opacity-100 transition-opacity">
          <button
            type="button"
            className="px-1.5 py-0.5 rounded bg-muted/10 hover:bg-primary/10 text-muted hover:text-primary transition-colors font-medium"
            onClick={(e) => {
              e.stopPropagation();
              setShowRaw(true);
            }}
            title="View raw hexdump"
          >
            raw
          </button>
          <span className="font-mono">@{node.raw.start.toString().padStart(4, '0')}</span>
          <span>{node.raw.size}B</span>
        </div>
      </div>

      {node.match.kind === 'type-mismatch' && (
        <div
          className="flex items-start gap-2 text-amber-600 dark:text-amber-400 text-[11px] py-1 ml-4 border-l-2 border-amber-500/15"
          style={{ marginLeft: `${depth * 16 + 32}px`, paddingLeft: '8px' }}
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          {node.match.reason}
        </div>
      )}

      <AnimatePresence initial={false}>
        {hasChildren && open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            {node.children!.map((c, i) => (
              <TreeNode key={`${c.raw.start}-${c.raw.tag}-${i}`} node={c} depth={depth + 1} hasSchema={hasSchema} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <DetailModal
        open={showDetail}
        onOpenChange={setShowDetail}
        node={node}
      />
      <RawModal
        open={showRaw}
        onOpenChange={setShowRaw}
        node={node}
      />
    </div>
  );
}

function DetailModal({ open, onOpenChange, node }: { open: boolean, onOpenChange: (o: boolean) => void, node: AnnotatedField }) {
  const bytes = useMemo(() => {
    const guess = node.raw.guesses.find(g => g.kind === 'len-bytes' || g.kind === 'len-utf8');
    if (guess?.kind === 'len-bytes') return guess.value;
    if (guess?.kind === 'len-utf8') return new TextEncoder().encode(guess.value);
    return new Uint8Array(0);
  }, [node]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-background/70 backdrop-blur-sm z-[100] animate-in fade-in duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-4xl max-h-[85vh] bg-card border border-border rounded-xl shadow-xl z-[101] flex flex-col overflow-hidden animate-in fade-in zoom-in-[0.98] duration-200">

          {/* Header */}
          <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <SearchCode className="w-4 h-4 text-primary" />
              <div>
                <Dialog.Title className="text-sm font-semibold flex items-center gap-2">
                  Field <span className="text-primary">#{node.raw.tag}</span>
                </Dialog.Title>
                <Dialog.Description className="text-[11px] text-muted mt-0.5 font-mono">
                  {wireLabel(node.raw.wireType)} &middot; offset {node.raw.start} &middot; {node.raw.size}B
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close className="p-1.5 rounded-md hover:bg-accent transition-colors">
              <X className="w-4 h-4 text-muted" />
            </Dialog.Close>
          </div>

          <div className="flex-1 flex min-h-0 divide-x divide-border overflow-hidden">
            {/* Left: Interpretations */}
            <div className="flex-1 flex flex-col min-h-0 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  <Braces className="w-3 h-3" /> Interpretations
                </div>
                <span className="text-[10px] text-muted/50">{node.raw.guesses.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-2">
                {node.raw.guesses.map((g, idx) => (
                  <div key={idx} className="bg-accent/40 border border-border rounded-lg p-3 hover:border-primary/20 transition-colors">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
                        {g.kind.replace('-', ' ')}
                      </span>
                      <button
                        onClick={() => navigator.clipboard.writeText(String(g.value))}
                        className="p-1 rounded hover:bg-primary/10 text-muted hover:text-primary transition-colors"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="text-sm font-mono break-all leading-relaxed bg-card/60 p-2.5 rounded-md border border-border/30 max-h-40 overflow-auto custom-scrollbar [&_span]:!overflow-visible [&_span]:!whitespace-normal [&_span]:!text-clip [&_span]:inline">
                      {renderGuess(g)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right: Hex */}
            <div className="w-96 flex flex-col min-h-0 p-4">
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted mb-3">
                <Terminal className="w-3 h-3" /> Hexdump
              </div>
              <div className="flex-1 bg-accent rounded-lg border border-border p-3 overflow-y-auto custom-scrollbar">
                {bytes.length > 0 ? (
                  <div className="font-mono text-xs leading-6 space-y-px">
                    {Array.from({ length: Math.ceil(bytes.length / 8) }).map((_, rowIndex) => (
                      <div key={rowIndex} className="flex gap-3 group/row">
                        <span className="text-muted/25 shrink-0">{(rowIndex * 8).toString(16).padStart(4, '0')}</span>
                        <span className="text-primary/70 group-hover/row:text-primary transition-colors">
                          {Array.from(bytes.slice(rowIndex * 8, rowIndex * 8 + 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-25">
                    <Binary className="w-5 h-5 mb-1.5" />
                    <p className="text-[10px]">No binary content</p>
                  </div>
                )}
              </div>
              {bytes.length > 0 && (
                <button
                  onClick={() => navigator.clipboard.writeText(Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''))}
                  className="mt-2 w-full bg-primary hover:bg-primary/90 text-white py-2 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 active:scale-[0.98]"
                >
                  <Copy className="w-3 h-3" /> Copy hex
                </button>
              )}
            </div>
          </div>

        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RawModal({ open, onOpenChange, node }: { open: boolean, onOpenChange: (o: boolean) => void, node: AnnotatedField }) {
  const bytes = useMemo(() => {
    const guess = node.raw.guesses.find(g => g.kind === 'len-bytes' || g.kind === 'len-utf8');
    if (guess?.kind === 'len-bytes') return guess.value;
    if (guess?.kind === 'len-utf8') return new TextEncoder().encode(guess.value);
    return new Uint8Array(0);
  }, [node]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-background/70 backdrop-blur-sm z-[100] animate-in fade-in duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[85vh] bg-card border border-border rounded-xl shadow-xl z-[101] flex flex-col overflow-hidden animate-in fade-in zoom-in-[0.98] duration-200">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <Terminal className="w-4 h-4 text-primary" />
              <div>
                <Dialog.Title className="text-sm font-semibold flex items-center gap-2">
                  Raw Hexdump <span className="text-primary">#{node.raw.tag}</span>
                </Dialog.Title>
                <Dialog.Description className="text-[11px] text-muted mt-0.5 font-mono">
                  {node.raw.size}B at offset {node.raw.start}
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close className="p-1.5 rounded-md hover:bg-accent transition-colors">
              <X className="w-4 h-4 text-muted" />
            </Dialog.Close>
          </div>
          <div className="flex-1 p-4 overflow-hidden">
            <div className="h-full bg-accent rounded-lg border border-border p-3 overflow-y-auto custom-scrollbar">
              {bytes.length > 0 ? (
                <div className="font-mono text-xs leading-6 space-y-px">
                  {Array.from({ length: Math.ceil(bytes.length / 8) }).map((_, rowIndex) => (
                    <div key={rowIndex} className="flex gap-3 group/row">
                      <span className="text-muted/25 shrink-0">{(rowIndex * 8).toString(16).padStart(4, '0')}</span>
                      <span className="text-primary/70 group-hover/row:text-primary transition-colors">
                        {Array.from(bytes.slice(rowIndex * 8, rowIndex * 8 + 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center opacity-25">
                  <Binary className="w-5 h-5 mb-1.5" />
                  <p className="text-[10px]">No binary content</p>
                </div>
              )}
            </div>
            {bytes.length > 0 && (
              <button
                onClick={() => navigator.clipboard.writeText(Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''))}
                className="mt-2 w-full bg-primary hover:bg-primary/90 text-white py-2 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 active:scale-[0.98]"
              >
                <Copy className="w-3 h-3" /> Copy hex
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function wireLabel(w: number): string {
  switch (w) {
    case 0: return 'Varint';
    case 1: return 'Fixed64';
    case 2: return 'Length';
    case 5: return 'Fixed32';
    default: return 'Unknown';
  }
}

function renderGuess(g: Guess): React.ReactNode {
  switch (g.kind) {
    case 'varint-uint64':
      return <span className="text-foreground font-medium">{g.value.toString()}</span>;
    case 'varint-int64-zigzag':
      return <span className="text-foreground/70">zz:{g.value.toString()}</span>;
    case 'varint-bool':
      return <span className={cn("px-1.5 py-px rounded text-[10px] font-medium", g.value ? "bg-primary/10 text-primary" : "bg-muted/10 text-muted")}>{String(g.value)}</span>;
    case 'varint-timestamp-sec':
    case 'varint-timestamp-ms':
      return (
        <span className="text-foreground/80 flex items-center gap-1.5">
          <Clock className="w-3 h-3 opacity-30" />
          {g.value.toLocaleString()}
        </span>
      );
    case 'i64-fixed':
      return <span className="text-foreground/70">fixed64:{g.value.toString()}</span>;
    case 'i64-double':
      return <span className="text-foreground/70">f64:{g.value}</span>;
    case 'i32-fixed':
      return <span className="text-foreground/70">fixed32:{g.value}</span>;
    case 'i32-float':
      return <span className="text-foreground/70">f32:{g.value.toFixed(6)}</span>;
    case 'len-utf8':
      return (
        <span className="text-primary/80 flex items-center gap-1.5 overflow-hidden">
          <Type className="w-3 h-3 shrink-0 opacity-30" />
          <span className="truncate">"{g.value}"</span>
        </span>
      );
    case 'len-bytes':
      return (
        <span className="text-muted flex items-center gap-1.5 overflow-hidden">
          <Binary className="w-3 h-3 shrink-0 opacity-20" />
          <span className="font-mono text-[11px] bg-accent px-1.5 py-px rounded border border-border">{hexPreview(g.value)}</span>
        </span>
      );
    case 'len-nested':
      return (
        <span className="text-foreground/70 flex items-center gap-1.5">
          <Braces className="w-3 h-3 opacity-30" />
          {g.value.length} fields
          {!g.consumedAll && <span className="text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 px-1.5 py-px rounded">partial</span>}
        </span>
      );
  }
}

function hexPreview(b: Uint8Array): string {
  const slice = b.length > 8 ? b.slice(0, 8) : b;
  let s = '';
  for (const byte of slice) s += byte.toString(16).padStart(2, '0') + ' ';
  return s.trim() + (b.length > 8 ? ' ...' : '');
}

