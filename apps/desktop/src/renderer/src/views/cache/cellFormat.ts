/**
 * Cell value helpers shared by the database explorer's grid + SQL console.
 *
 * The backend hands cells across the wire as {@link DbCell} (INTEGER→decimal
 * string, BLOB→hex preview) and takes edits back as {@link DbInputValue}. These
 * helpers convert between those wire shapes and the plain strings the DOM
 * inputs work with, plus decide which cells are editable.
 */

import type { DbCell, DbInputValue, DbColumn } from '@weq/service';

/** Longest BLOB hex we inline in a cell before eliding. */
const BLOB_HEX_PREVIEW = 16;

/** Human-readable text for one cell (used for display + copy). */
export function cellText(cell: DbCell): string {
  if (cell === null) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  if (cell.t === 'int') return cell.v;
  // BLOB — never show raw bytes; a short hex preview + length.
  const head = cell.hex.slice(0, BLOB_HEX_PREVIEW);
  const more = cell.hex.length > BLOB_HEX_PREVIEW ? '…' : '';
  return `<BLOB ${cell.bytes}B · ${head}${more}>`;
}

/** A visual tag for the cell's SQLite storage class (drives subtle styling). */
export function cellKind(cell: DbCell): 'null' | 'int' | 'real' | 'text' | 'blob' {
  if (cell === null) return 'null';
  if (typeof cell === 'string') return 'text';
  if (typeof cell === 'number') return 'real';
  return cell.t === 'int' ? 'int' : 'blob';
}

/** True when a cell may be edited inline. BLOBs are read-only in the grid. */
export function isCellEditable(cell: DbCell): boolean {
  return cellKind(cell) !== 'blob';
}

/** The string an editor should start from when editing a cell. */
export function cellEditText(cell: DbCell): string {
  if (cell === null) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  if (cell.t === 'int') return cell.v;
  return cell.hex; // shouldn't reach here (BLOB not editable) — hex fallback
}

/**
 * Turn user-typed text into a {@link DbInputValue}, using the column's declared
 * affinity to pick INTEGER vs REAL vs TEXT. An empty string maps to NULL so the
 * user can clear a cell. `null`-return means "leave as text" fallback.
 */
export function textToInput(text: string, column: DbColumn): DbInputValue {
  if (text === '') return { t: 'null' };
  const aff = affinity(column.type);
  if (aff === 'integer' && /^[+-]?\d+$/.test(text.trim())) {
    return { t: 'int', v: text.trim() };
  }
  if (aff === 'real' || aff === 'integer') {
    const n = Number(text);
    if (Number.isFinite(n)) return { t: 'real', v: n };
  }
  return { t: 'text', v: text };
}

/** SQLite type affinity from a declared column type string. */
function affinity(declared: string): 'integer' | 'real' | 'text' | 'blob' | 'numeric' {
  const t = declared.toUpperCase();
  if (t.includes('INT')) return 'integer';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'text';
  if (t.includes('BLOB') || t === '') return 'blob';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'real';
  return 'numeric';
}
