/**
 * BLOB hex viewer / editor lightbox (opened from a BLOB cell in the database
 * explorer's data grid or SQL result table).
 *
 * Classic hexdump layout: an 8-digit offset column, 16 hex bytes per row, and
 * an ASCII gutter (non-printable bytes shown as `.`). When `editable` is set and
 * `onSave` is provided, each byte is an inline 2-char hex input whose edits flow
 * straight into the ASCII gutter, plus a "原始 Hex" textarea that replaces the
 * whole buffer at once (the path for length changes / pasting). Read-only opens
 * (SQL results, or over-large blobs) drop the inputs and only offer view + copy.
 *
 * The wire already carries the full lowercase hex (`DbCell` blob → `{ hex }`),
 * and `updateCell` already accepts `{ t: 'blob', hex }`, so nothing here decrypts
 * or touches the backend beyond the parent's existing save mutation.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { X, Copy, Save } from 'lucide-react';
import { useAppDialog } from '../../lib/dialogUtils';

/** Bytes beyond this render as read-only spans (too many inputs to be usable). */
const MAX_EDIT_BYTES = 2048;
/** Bytes beyond this are elided from the dump entirely (bulk box still has all). */
const MAX_RENDER_BYTES = 16384;
const ROW = 16;

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

  const canEdit = editable && Boolean(onSave);
  const inlineEditable = canEdit && data.length <= MAX_EDIT_BYTES;

  const rendered = data.length > MAX_RENDER_BYTES ? data.slice(0, MAX_RENDER_BYTES) : data;
  const elided = data.length - rendered.length;

  const rows = useMemo(() => {
    const out: number[][] = [];
    for (let i = 0; i < rendered.length; i += ROW) {
      out.push(rendered.slice(i, i + ROW));
    }
    return out;
  }, [rendered]);

  function setByte(index: number, value: number): void {
    setData((prev) => {
      const next = prev.slice();
      next[index] = value & 0xff;
      setBulk(formatHexBlock(next));
      return next;
    });
  }

  function applyBulk(): void {
    const parsed = parseHex(bulk);
    setData(parsed);
    setBulk(formatHexBlock(parsed));
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
      <div className="weq-blob-dialog" role="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <header className="weq-blob-head">
          <div className="weq-blob-title">
            <h3>二进制数据{columnName ? ` · ${columnName}` : ''}</h3>
            <code>
              {data.length} 字节{canEdit ? '' : ' · 只读'}
            </code>
          </div>
          <button type="button" className="weq-blob-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-blob-body">
          {data.length === 0 ? (
            <div className="weq-blob-empty">空 BLOB（0 字节）</div>
          ) : (
            <div className="weq-blob-dump">
              {rows.map((bytes, ri) => {
                const base = ri * ROW;
                return (
                  <div className="weq-blob-line" key={ri}>
                    <span className="weq-blob-offset">
                      {base.toString(16).padStart(8, '0')}
                    </span>
                    <span className="weq-blob-hexes">
                      {bytes.map((b, ci) => {
                        const idx = base + ci;
                        return inlineEditable ? (
                          <input
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
                          <span key={ci} className="weq-blob-byte">
                            {b.toString(16).padStart(2, '0')}
                          </span>
                        );
                      })}
                      {/* Pad the last short row so the ASCII gutter stays aligned. */}
                      {bytes.length < ROW
                        ? Array.from({ length: ROW - bytes.length }, (_, k) => (
                            <span key={`pad${k}`} className="weq-blob-byte is-pad" />
                          ))
                        : null}
                    </span>
                    <span className="weq-blob-ascii">
                      {bytes.map((b, ci) => (
                        <span
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
                  仅显示前 {MAX_RENDER_BYTES} 字节，其余 {elided} 字节已省略（可在下方「原始 Hex」中查看 /
                  编辑完整内容）。
                </div>
              ) : null}
            </div>
          )}

          {canEdit && !inlineEditable && data.length > MAX_EDIT_BYTES ? (
            <div className="weq-blob-note">
              数据较大（超过 {MAX_EDIT_BYTES} 字节），逐字节编辑已禁用；请使用下方「原始 Hex」整体替换。
            </div>
          ) : null}

          {canEdit ? (
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
