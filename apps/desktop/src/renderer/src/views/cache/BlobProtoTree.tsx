/**
 * Protobuf tree for the BLOB lightbox — the schema-free decoder rendered as an
 * editable outline.
 *
 * Field names come from the flat tag dictionary (`@weq/codec/dictionary`), which
 * holds for tags above 1000. Four states are distinguished so the user can tell
 * "we know this" from "we're guessing":
 *
 *   known      accent  a single schema declares this tag
 *   ambiguous  amber   several schemas disagree — all candidates are listed
 *   undefined  red     above the threshold but declared nowhere
 *   small      muted   below the threshold, meaning is parent-relative
 *
 * Editing goes through the pure helpers in `@weq/codec/raw` so the encoder's
 * "untouched bytes stay verbatim" guarantee holds; this file only wires them to
 * inputs. Edited rows are marked so it's obvious what will change on save.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { ChevronRight, RefreshCw, Trash2, Plus } from 'lucide-react';
import {
  appendNode,
  newNode,
  payloadOf,
  reinterpret,
  removeNode,
  updateNode,
  valueAlternatives,
  type PbNode,
  type PbValue,
} from '@weq/codec/raw';
import type { WireType } from '@weq/codec/raw';
import { lookupTag, type TagStatus } from '@weq/codec/dictionary';

const WIRE_LABELS: Record<WireType, string> = {
  0: 'VARINT',
  1: 'I64',
  2: 'LEN',
  5: 'I32',
};

const WIRE_CHOICES: WireType[] = [0, 2, 1, 5];

export function BlobProtoTree({
  nodes,
  original,
  editable,
  onChange,
}: {
  nodes: PbNode[];
  /** The buffer `nodes` was built from — needed to re-read payloads. */
  original: Uint8Array;
  editable: boolean;
  onChange: (next: PbNode[]) => void;
}): ReactElement {
  return (
    <div className="weq-pb-tree">
      {nodes.length === 0 ? (
        <div className="weq-pb-none">没有可解析的字段</div>
      ) : (
        nodes.map((n) => (
          <Row
            key={n.id}
            node={n}
            depth={0}
            original={original}
            editable={editable}
            onChange={onChange}
            all={nodes}
          />
        ))
      )}
      {editable ? (
        <AddField
          depth={0}
          onAdd={(tag, wire) => onChange(appendNode(nodes, null, newNode(tag, wire)))}
        />
      ) : null}
    </div>
  );
}

function Row({
  node,
  depth,
  original,
  editable,
  onChange,
  all,
}: {
  node: PbNode;
  depth: number;
  original: Uint8Array;
  editable: boolean;
  onChange: (next: PbNode[]) => void;
  /** The whole tree — mutation helpers operate from the root. */
  all: PbNode[];
}): ReactElement {
  const [open, setOpen] = useState(true);
  const nested = node.value.kind === 'nested';
  const info = lookupTag(node.tag);

  // Alternatives are derived from the CURRENT bytes, so they stay right after
  // the user edits a value.
  const alternatives = useMemo(() => {
    try {
      return valueAlternatives(node.wireType, payloadOf(node, [node.tag], original));
    } catch {
      return [];
    }
  }, [node, original]);

  function cycle(): void {
    if (alternatives.length < 2) return;
    const at = alternatives.findIndex((a) => a.kind === node.value.kind);
    const next = alternatives[(at + 1) % alternatives.length]!;
    onChange(reinterpret(all, node.id, next, original));
  }

  return (
    <>
      <div
        className={`weq-pb-row is-${info.status}${node.dirty ? ' is-dirty' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 6}px` }}
      >
        <button
          type="button"
          className={`weq-pb-caret${nested && open ? ' is-open' : ''}`}
          onClick={() => nested && setOpen((v) => !v)}
          disabled={!nested}
          aria-label={nested ? (open ? '折叠' : '展开') : undefined}
        >
          {nested ? <ChevronRight size={12} /> : <span className="weq-pb-dot" />}
        </button>

        <TagLabel tag={node.tag} status={info.status} names={info.names.map((n) => n.name)} />

        <span className="weq-pb-wire">{WIRE_LABELS[node.wireType]}</span>

        <span className="weq-pb-value">
          {nested ? (
            <span className="weq-pb-nested">{node.children?.length ?? 0} 个字段</span>
          ) : (
            <ValueInput
              value={node.value}
              editable={editable}
              onChange={(v) => onChange(updateNode(all, node.id, (n) => ({ ...n, value: v })))}
            />
          )}
        </span>

        <span className="weq-pb-meta">
          {node.origin ? `@${node.origin.start} · ${node.origin.size}B` : '新增'}
        </span>

        <span className="weq-pb-actions">
          {alternatives.length > 1 ? (
            <button
              type="button"
              className="weq-pb-act"
              onClick={cycle}
              title={`切换解释（共 ${alternatives.length} 种）`}
            >
              <RefreshCw size={12} />
            </button>
          ) : null}
          {editable ? (
            <button
              type="button"
              className="weq-pb-act is-danger"
              onClick={() => onChange(removeNode(all, node.id))}
              title="删除该字段"
            >
              <Trash2 size={12} />
            </button>
          ) : null}
        </span>
      </div>

      {nested && open ? (
        <>
          {(node.children ?? []).map((c) => (
            <Row
              key={c.id}
              node={c}
              depth={depth + 1}
              original={original}
              editable={editable}
              onChange={onChange}
              all={all}
            />
          ))}
          {editable ? (
            <AddField
              depth={depth + 1}
              onAdd={(tag, wire) => onChange(appendNode(all, node.id, newNode(tag, wire)))}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function TagLabel({
  tag,
  status,
  names,
}: {
  tag: number;
  status: TagStatus;
  names: string[];
}): ReactElement {
  if (status === 'known' || status === 'ambiguous') {
    return (
      <span className="weq-pb-name" title={names.join(' | ')}>
        <span className="weq-pb-name-text">{names.join(' | ')}</span>
        <span className="weq-pb-tagnum">({tag})</span>
      </span>
    );
  }
  return (
    <span
      className="weq-pb-name"
      title={
        status === 'undefined' ? '该 tag 尚未在任何 schema 中定义' : '小 tag，含义取决于父消息'
      }
    >
      <span className="weq-pb-name-text is-bare">{tag}</span>
    </span>
  );
}

function ValueInput({
  value,
  editable,
  onChange,
}: {
  value: PbValue;
  editable: boolean;
  onChange: (v: PbValue) => void;
}): ReactElement {
  if (value.kind === 'bool') {
    return editable ? (
      <label className="weq-pb-bool">
        <input
          type="checkbox"
          checked={value.on}
          onChange={(e) => onChange({ kind: 'bool', on: e.target.checked })}
        />
        <span>{String(value.on)}</span>
      </label>
    ) : (
      <span className="weq-pb-static">{String(value.on)}</span>
    );
  }

  const text = value.kind === 'bytes' ? value.hex : value.kind === 'nested' ? '' : value.text;
  const hint = valueHint(value);

  return (
    <span className="weq-pb-field">
      {editable ? (
        <input
          className="weq-pb-input"
          value={text}
          spellCheck={false}
          onChange={(e) => onChange(withText(value, e.target.value))}
        />
      ) : (
        <span className="weq-pb-static">{text || '(空)'}</span>
      )}
      {hint ? <span className="weq-pb-hint">{hint}</span> : null}
    </span>
  );
}

/** A short suffix clarifying how the raw text is being read. */
function valueHint(value: PbValue): string | null {
  switch (value.kind) {
    case 'timestamp': {
      const n = Number(value.text);
      if (!Number.isFinite(n)) return null;
      const d = new Date(value.unit === 'sec' ? n * 1000 : n);
      return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
    }
    case 'zigzag':
      return 'zigzag';
    case 'bytes':
      return 'hex';
    case 'float':
      return `f${value.bits}`;
    case 'fixed':
      return `fixed${value.bits}`;
    default:
      return null;
  }
}

function withText(value: PbValue, text: string): PbValue {
  switch (value.kind) {
    case 'bytes':
      return { kind: 'bytes', hex: text };
    case 'varint':
    case 'zigzag':
    case 'utf8':
      return { kind: value.kind, text };
    case 'timestamp':
      return { kind: 'timestamp', unit: value.unit, text };
    case 'fixed':
    case 'float':
      return { kind: value.kind, bits: value.bits, text };
    // bool renders a checkbox and nested has no text input.
    case 'bool':
    case 'nested':
      return value;
  }
}

function AddField({
  depth,
  onAdd,
}: {
  depth: number;
  onAdd: (tag: number, wire: WireType) => void;
}): ReactElement {
  const [tag, setTag] = useState('');
  const [wire, setWire] = useState<WireType>(0);
  const parsed = Number(tag);
  const valid = /^\d+$/.test(tag.trim()) && parsed >= 1 && parsed <= 536870911;

  function submit(): void {
    if (!valid) return;
    onAdd(parsed, wire);
    setTag('');
  }

  return (
    <div className="weq-pb-add" style={{ paddingLeft: `${depth * 16 + 24}px` }}>
      <Plus size={12} className="weq-pb-add-icon" />
      <input
        className="weq-pb-add-tag"
        placeholder="tag"
        value={tag}
        spellCheck={false}
        onChange={(e) => setTag(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <select
        className="weq-pb-add-wire"
        value={wire}
        onChange={(e) => setWire(Number(e.target.value) as WireType)}
      >
        {WIRE_CHOICES.map((w) => (
          <option key={w} value={w}>
            {WIRE_LABELS[w]}
          </option>
        ))}
      </select>
      <button type="button" className="weq-pb-add-btn" onClick={submit} disabled={!valid}>
        添加字段
      </button>
    </div>
  );
}
