/**
 * BLOB viewer / editor lightbox (opened from a BLOB cell in the database
 * explorer's data grid or SQL result table).
 *
 * Two views over the same bytes:
 *
 *  - Hex — classic hexdump: an 8-digit offset column, 16 hex bytes per row, and
 *    an ASCII gutter (non-printable bytes shown as `.`). When editable, each
 *    byte is an inline 2-char hex input, plus a "原始 Hex" textarea that
 *    replaces the whole buffer at once (the path for length changes / pasting).
 *  - Protobuf — only when the bytes parse as protobuf. Shows the schema-free
 *    decoded tree with field names from the global tag dictionary, and lets the
 *    user change values, drop fields, and insert new ones.
 *
 * Both views write back to one `data` byte array, so "保存" is unchanged: the
 * wire already carries the full lowercase hex (`DbCell` blob → `{ hex }`) and
 * `updateCell` already accepts `{ t: 'blob', hex }`. Nothing here decrypts or
 * touches the backend beyond the parent's existing save mutation.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { X, Copy, Save, Binary, Braces } from 'lucide-react';
import { buildEditTree, encodeEditTree, PbEncodeError, type PbNode } from '@weq/codec/raw';
import { useAppDialog } from '../../lib/dialogUtils';
import { BlobProtoTree } from './BlobProtoTree';

/** Bytes beyond this render as read-only spans (too many inputs to be usable). */
const MAX_EDIT_BYTES = 2048;
/** Bytes beyond this are elided from the dump entirely (bulk box still has all). */
const MAX_RENDER_BYTES = 16384;
const ROW = 16;

type Tab = 'hex' | 'proto';

/** The tree plus the exact buffer it was built from — the encoder needs both. */
interface ProtoState {
  nodes: PbNode[];
  source: Uint8Array;
}

export function BlobHexModal({
  hex,
  columnName,
  editable,
  onClose,
  onSave,
}: {
  /** Initial BLOB contents as a continuous lowercase hex string. */
  hex: string;
  /** Column name shown in the title, if known. */
  columnName?: string;
  /** True to allow editing (still needs onSave to actually persist). */
  editable: boolean;
  onClose: () => void;
  /** Persist the edited bytes (as a continuous hex string). Omit → read-only. */
  onSave?: (hex: string) => Promise<void>;
}): ReactElement {
  const dialog = useAppDialog();
  const [data, setData] = useState<number[]>(() => parseHex(hex));
  const [bulk, setBulk] = useState<string>(() => formatHexBlock(parseHex(hex)));
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>('hex');
  const [proto, setProto] = useState<ProtoState | null>(() => buildProto(parseHex(hex)));

  const canEdit = editable && Boolean(onSave);
  const inlineEditable = canEdit && data.length <= MAX_EDIT_BYTES;
  const isProto = tab === 'proto' && proto !== null;

  const rendered = data.length > MAX_RENDER_BYTES ? data.slice(0, MAX_RENDER_BYTES) : data;
  const elided = data.length - rendered.length;

  const rows = useMemo(() => {
    const out: number[][] = [];
    for (let i = 0; i < rendered.length; i += ROW) {
      out.push(rendered.slice(i, i + ROW));
    }
    return out;
  }, [rendered]);

  /** Adopt a new byte array from the Hex side and rebuild the tree over it. */
  function setBytes(next: number[]): void {
    setData(next);
    setBulk(formatHexBlock(next));
    setProto(buildProto(next));
  }

  function setByte(index: number, value: number): void {
    const next = data.slice();
    next[index] = value & 0xff;
    setBytes(next);
  }

  function applyBulk(): void {
    setBytes(parseHex(bulk));
  }

  /** Adopt an edited tree: re-encode to bytes so both tabs stay in sync. */
  function applyTree(nodes: PbNode[]): void {
    if (!proto) return;
    let encoded: Uint8Array;
    try {
      encoded = encodeEditTree(nodes, proto.source);
    } catch (e) {
      // Keep the edit visible so the user can fix the offending value; the byte
      // array just doesn't advance until it encodes.
      setProto({ ...proto, nodes });
      const where = e instanceof PbEncodeError ? `字段 ${e.path.join(' → ')}：` : '';
      dialog.error('无法编码', `${where}${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setProto({ nodes, source: proto.source });
    const bytes = Array.from(encoded);
    setData(bytes);
    setBulk(formatHexBlock(bytes));
  }

  async function copyProtoJson(): Promise<void> {
    if (!proto) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(pbNodesToJson(proto.nodes), null, 2));
      dialog.success('已复制', 'Protobuf 已复制为 JSON（bytes 字段以 hex 表示）');
    } catch (e) {
      dialog.error('复制失败', e instanceof Error ? e.message : String(e));
    }
  }

  async function copyHex(): Promise<void> {
    try {
      await navigator.clipboard.writeText(bytesToHex(data));
      dialog.success('已复制', `${data.length} 字节的 Hex 已复制到剪贴板`);
    } catch (e) {
      dialog.error('复制失败', e instanceof Error ? e.message : String(e));
    }
  }

  async function save(): Promise<void> {
    if (!onSave || saving) return;
    setSaving(true);
    try {
      await onSave(bytesToHex(data));
      onClose();
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="weq-blob-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className={`weq-blob-dialog${isProto ? ' is-proto' : ''}`}
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-blob-head">
          <div className="weq-blob-title">
            <h3>二进制数据{columnName ? ` · ${columnName}` : ''}</h3>
            <code>
              {data.length} 字节{canEdit ? '' : ' · 只读'}
            </code>
          </div>
          <div className="weq-blob-tabs">
            <button
              type="button"
              className={`weq-blob-tab${tab === 'hex' ? ' is-on' : ''}`}
              onClick={() => setTab('hex')}
            >
              <Binary size={13} />
              Hex
            </button>
            <button
              type="button"
              className={`weq-blob-tab${tab === 'proto' ? ' is-on' : ''}`}
              onClick={() => setTab('proto')}
              disabled={proto === null}
              title={proto === null ? '这段数据不是有效的 Protobuf' : undefined}
            >
              <Braces size={13} />
              Protobuf
            </button>
          </div>
          <button type="button" className="weq-blob-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-blob-body">
          {isProto ? (
            <BlobProtoTree
              nodes={proto.nodes}
              original={proto.source}
              editable={canEdit}
              onChange={applyTree}
            />
          ) : data.length === 0 ? (
            <div className="weq-blob-empty">空 BLOB（0 字节）</div>
          ) : (
            <div className="weq-blob-dump">
              {rows.map((bytes, ri) => {
                const base = ri * ROW;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                  <div className="weq-blob-line" key={ri}>
                    <span className="weq-blob-offset">{base.toString(16).padStart(8, '0')}</span>
                    <span className="weq-blob-hexes">
                      {bytes.map((b, ci) => {
                        const idx = base + ci;
                        return inlineEditable ? (
                          <input
                            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                            key={ci}
                            className="weq-blob-byte-input"
                            value={b.toString(16).padStart(2, '0')}
                            spellCheck={false}
                            onChange={(e) => {
                              const clean = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(-2);
                              setByte(idx, clean ? parseInt(clean, 16) : 0);
                            }}
                          />
                        ) : (
                          // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                          <span key={ci} className="weq-blob-byte">
                            {b.toString(16).padStart(2, '0')}
                          </span>
                        );
                      })}
                      {/* Pad the last short row so the ASCII gutter stays aligned. */}
                      {bytes.length < ROW
                        ? Array.from({ length: ROW - bytes.length }, (_, k) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                            <span key={`pad${k}`} className="weq-blob-byte is-pad" />
                          ))
                        : null}
                    </span>
                    <span className="weq-blob-ascii">
                      {bytes.map((b, ci) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                          key={ci}
                          className={`weq-blob-ch${isPrintable(b) ? '' : ' is-dot'}`}
                        >
                          {isPrintable(b) ? String.fromCharCode(b) : '.'}
                        </span>
                      ))}
                    </span>
                  </div>
                );
              })}
              {elided > 0 ? (
                <div className="weq-blob-elided">
                  仅显示前 {MAX_RENDER_BYTES} 字节，其余 {elided} 字节已省略（可在下方「原始
                  Hex」中查看 / 编辑完整内容）。
                </div>
              ) : null}
            </div>
          )}

          {!isProto && canEdit && !inlineEditable && data.length > MAX_EDIT_BYTES ? (
            <div className="weq-blob-note">
              数据较大（超过 {MAX_EDIT_BYTES} 字节），逐字节编辑已禁用；请使用下方「原始
              Hex」整体替换。
            </div>
          ) : null}

          {!isProto && canEdit ? (
            <div className="weq-blob-bulk">
              <div className="weq-blob-bulk-head">
                <span>原始 Hex（可整体替换 / 改变长度）</span>
                <button type="button" className="weq-cache-tool" onClick={applyBulk}>
                  应用
                </button>
              </div>
              <textarea
                className="weq-blob-bulk-input"
                spellCheck={false}
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
                placeholder="粘贴 / 编辑 Hex（忽略空白与非十六进制字符），点「应用」写入上方"
              />
            </div>
          ) : null}
        </div>

        <footer className="weq-blob-foot">
          <button type="button" className="weq-cache-tool" onClick={() => void copyHex()}>
            <Copy size={14} />
            复制 Hex
          </button>
          {isProto ? (
            <button type="button" className="weq-cache-tool" onClick={() => void copyProtoJson()}>
              <Copy size={14} />
              复制 JSON
            </button>
          ) : null}
          <span className="weq-cache-spacer" />
          <button type="button" className="weq-cache-tool" onClick={onClose}>
            {canEdit ? '取消' : '关闭'}
          </button>
          {canEdit ? (
            <button
              type="button"
              className="weq-cache-btn is-primary"
              onClick={() => void save()}
              disabled={saving}
            >
              <Save size={14} />
              {saving ? '保存中…' : '保存'}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

/**
 * Build the protobuf view, or null when the bytes aren't protobuf. Requiring
 * the fields to consume the buffer exactly is what keeps arbitrary binary from
 * being presented as a (nonsense) message tree.
 */
function buildProto(data: number[]): ProtoState | null {
  if (data.length === 0) return null;
  const source = Uint8Array.from(data);
  let nodes: PbNode[];
  try {
    nodes = buildEditTree(source);
  } catch {
    return null;
  }
  if (nodes.length === 0) return null;
  const last = nodes[nodes.length - 1]!;
  if (!last.origin || last.origin.start + last.origin.size !== source.length) return null;
  return { nodes, source };
}

// ── hex helpers ─────────────────────────────────────────────────────────────

/** Parse a hex string (ignoring whitespace / non-hex) into a byte array. */
function parseHex(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  // Drop a dangling final nibble rather than silently zero-padding it.
  for (let i = 0; i + 2 <= clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

function bytesToHex(data: number[]): string {
  let out = '';
  for (const b of data) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Grouped hex for the bulk textarea: space between bytes, 16 per line. */
function formatHexBlock(data: number[]): string {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += ROW) {
    lines.push(
      data
        .slice(i, i + ROW)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' '),
    );
  }
  return lines.join('\n');
}

function isPrintable(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

// ── proto → JSON helpers ─────────────────────────────────────────────────────

function pbNodesToJson(nodes: PbNode[]): Record<string, unknown> {
  const groups = new Map<number, unknown[]>();
  for (const node of nodes) {
    const arr = groups.get(node.tag) ?? [];
    arr.push(pbNodeValue(node));
    groups.set(node.tag, arr);
  }
  const out: Record<string, unknown> = {};
  for (const [tag, arr] of groups) {
    out[String(tag)] = arr.length === 1 ? arr[0] : arr;
  }
  return out;
}

function pbNodeValue(node: PbNode): unknown {
  const v = node.value;
  if (v.kind === 'nested') return pbNodesToJson(node.children ?? []);
  if (v.kind === 'bool') return v.on;
  if (v.kind === 'bytes') return v.hex;
  return v.text;
}
