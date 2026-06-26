/**
 * Database-corruption error detection + a native-binding wrapper that re-emits
 * "this query failed in a way that smells like a corrupt database" signals.
 *
 * Why here: `@weq/db` already owns the knowledge of *how* QQ NT databases are
 * queried (via the native `executeSql*` methods on {@link NtHelperBinding}). It
 * is therefore the natural home for "what does a corruption error look like".
 *
 * Policy — *when* to actually watch for corruption (online vs static account) —
 * lives one layer up in `@weq/account`, which decides whether to wrap a
 * session's binding with {@link wrapBindingForCorruption}.
 */

import type { NtHelperBinding } from '@weq/native';

/**
 * Lower-cased substrings that strongly indicate the underlying SQLite /
 * SQLCipher database file is corrupt (SQLITE_CORRUPT / SQLITE_NOTADB and
 * friends). Intentionally conservative: we exclude transient / unrelated
 * failures ("database is locked", "no such table", "disk I/O error", key
 * mismatches) so a one-off query error never triggers a false "数据库损坏"
 * force-close. The full health check is the confirmation step regardless — a
 * match here only *requests* that check, it does not declare corruption.
 */
const CORRUPTION_SIGNATURES = [
  'database disk image is malformed',
  'disk image is malformed',
  'database is malformed',
  'malformed database schema',
  'file is not a database',
  'is not a database',
  'database corruption',
  'sqlite_corrupt',
  'sqlite_notadb',
] as const;

/** Best-effort flatten of an unknown thrown value into searchable text. */
function extractMessage(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) {
    let msg = err.message;
    const cause = (err as { cause?: unknown }).cause;
    if (cause != null && cause !== err) msg += ` ${extractMessage(cause)}`;
    return msg;
  }
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === 'string') parts.push(obj.message);
    if (typeof obj.code === 'string') parts.push(obj.code);
    if (parts.length > 0) return parts.join(' ');
  }
  return String(err);
}

/**
 * True when `err` looks like it was caused by on-disk database corruption
 * (high-probability signal, not a guarantee). Callers should follow up with a
 * real integrity check before acting.
 */
export function isLikelyCorruptionError(err: unknown): boolean {
  const msg = extractMessage(err).toLowerCase();
  if (!msg) return false;
  return CORRUPTION_SIGNATURES.some((sig) => msg.includes(sig));
}

/** Payload handed to the corruption-suspected hook. */
export interface CorruptionSuspectInfo {
  /** Database file whose query rejected. */
  dbPath: string;
  /** The original rejection (re-thrown to the caller untouched). */
  error: unknown;
}

const GUARDED_METHODS: ReadonlySet<string> = new Set([
  'executeSql',
  'executeSqlWithKey',
  'executeSqlWrite',
  'executeSqlWriteWithKey',
]);

/**
 * Return a transparent proxy of `nt` that watches the four `executeSql*`
 * methods: whenever one rejects with a {@link isLikelyCorruptionError} error,
 * `onSuspected` is invoked (best-effort — its own throw is swallowed) and the
 * original error is re-thrown unchanged. Every other method/property is
 * forwarded verbatim.
 *
 * The wrapper adds nothing on the success path and never changes what a query
 * returns or throws; it is purely an observer.
 */
export function wrapBindingForCorruption(
  nt: NtHelperBinding,
  onSuspected: (info: CorruptionSuspectInfo) => void,
): NtHelperBinding {
  const report = (err: unknown, dbPath: string): void => {
    if (!isLikelyCorruptionError(err)) return;
    try {
      onSuspected({ dbPath, error: err });
    } catch {
      /* the health hook must never break the query path */
    }
  };

  return new Proxy(nt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (typeof prop === 'string' && GUARDED_METHODS.has(prop)) {
        return (...args: unknown[]): unknown => {
          const dbPath = typeof args[0] === 'string' ? args[0] : '';
          let result: unknown;
          try {
            result = fn.apply(target, args);
          } catch (err) {
            // Synchronous throw — unexpected for the async napi methods, but
            // handled for completeness.
            report(err, dbPath);
            throw err;
          }
          if (result instanceof Promise) {
            return result.catch((err: unknown) => {
              report(err, dbPath);
              throw err;
            });
          }
          return result;
        };
      }
      // Bind plain methods (e.g. computeBkn, closeDb) to the real target so
      // `this` stays correct on the napi object.
      return fn.bind(target);
    },
  });
}
