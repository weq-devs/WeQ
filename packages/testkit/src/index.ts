/**
 * Shared configuration for WeQ's local integration / probe scripts.
 *
 * Every `test/` script used to hardcode one developer's QQ data directory and
 * database key (e.g. `D:\estkim\T\Tencent Files\1707889225\nt_qq\...`), which
 * meant nobody else could run them. This module centralises all of that into a
 * single root `.env` file so a script only ever asks for what it needs.
 *
 * Usage in a script:
 *
 *   import { testEnv, qqDbPath } from '@weq/testkit';
 *
 *   const db = new GroupMsgDb(native.ntHelper, {
 *     dbPath: qqDbPath('nt_msg.db'),
 *     key: testEnv.key,
 *     algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
 *   });
 *
 * Configuration: copy `.env.example` at the repo root to `.env` and fill in
 * your own QQ data-directory root and database key. See that file for details.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the monorepo root (…/packages/testkit/src → up 3). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Load the root `.env` once, if present. Values already in the real
// environment win, so `WEQ_TEST_DB_KEY=... pnpm test:x` still overrides.
const ENV_FILE = path.join(REPO_ROOT, '.env');
if (existsSync(ENV_FILE)) {
  // Node ≥ 20.12 — no dotenv dependency needed.
  process.loadEnvFile(ENV_FILE);
}

/** Read an env var, throwing a helpful message if it is missing/empty. */
function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(
      `[@weq/testkit] Missing required config "${name}".\n` +
        `  → Copy ".env.example" at the repo root to ".env" and fill in your values.\n` +
        `  → Or pass it inline, e.g. ${name}=... pnpm --filter <pkg> <script>`,
    );
  }
  return v;
}

/** Read an optional env var, falling back to `fallback` (default ''). */
function optional(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** Truthy env flag: "1", "true", "yes" (case-insensitive) → true. */
function flag(name: string): boolean {
  return /^(1|true|yes)$/i.test(optional(name));
}

/**
 * The root of the QQ data directory — the `nt_qq` folder that contains both
 * `nt_db/` (databases) and `nt_data/` (media/emoji resources).
 *
 * Example (Windows): `D:\Tencent Files\1234567890\nt_qq`
 * Example (Linux):   `/home/you/.config/QQ/nt_qq`
 *
 * Lazily validated: only scripts that actually build a path pay the cost of
 * requiring it, so key-only scripts still run without it.
 */
function qqRoot(): string {
  return required('WEQ_TEST_QQ_ROOT');
}

/** Absolute path to a database file under `<qqRoot>/nt_db/<name>`. */
export function qqDbPath(name: string): string {
  return path.join(qqRoot(), 'nt_db', name);
}

/** Absolute path to the `nt_db` directory itself (`<qqRoot>/nt_db`). */
export function qqDbDir(): string {
  return path.join(qqRoot(), 'nt_db');
}

/** Absolute path to a resource under `<qqRoot>/nt_data/<relative>`. */
export function ntDataPath(relative: string): string {
  return path.join(qqRoot(), 'nt_data', relative);
}

/**
 * Centralised accessors for every value the test scripts consume.
 * Property access is what triggers the "missing config" error, so importing
 * this object is always cheap.
 */
export const testEnv = {
  /** The `nt_qq` root directory (see {@link qqRoot}). */
  get qqRoot(): string {
    return qqRoot();
  },

  /** Primary SQLCipher database key (`WEQ_TEST_DB_KEY`). */
  get key(): string {
    return required('WEQ_TEST_DB_KEY');
  },

  /** QQ number of the logged-in account under test (`WEQ_TEST_UIN`). */
  get uin(): string {
    return required('WEQ_TEST_UIN');
  },

  /** Encoded uid of the account under test (`WEQ_TEST_UID`), optional. */
  get uid(): string {
    return optional('WEQ_TEST_UID');
  },

  // ---- Convenience DB paths (all derived from qqRoot) --------------------
  /** `<qqRoot>/nt_db/nt_msg.db` — the main message database. */
  get msgDbPath(): string {
    return process.env.WEQ_TEST_DB_PATH ?? qqDbPath('nt_msg.db');
  },
  /** `<qqRoot>/nt_db/profile_info.db`. */
  get profileDbPath(): string {
    return process.env.WEQ_TEST_PROFILE_DB_PATH ?? qqDbPath('profile_info.db');
  },
  /** `<qqRoot>/nt_db/buddy_msg_fts.db`. */
  get ftsDbPath(): string {
    return process.env.WEQ_TEST_FTS_DB_PATH ?? qqDbPath('buddy_msg_fts.db');
  },

  // ---- Misc knobs used by individual scripts ----------------------------
  /** Search keyword for message-search scripts (`WEQ_TEST_KEYWORD`). */
  get keyword(): string {
    return optional('WEQ_TEST_KEYWORD', '你好');
  },
  /** Peer id for scripts that target one conversation (`WEQ_PEER`). */
  get peer(): string {
    return optional('WEQ_PEER');
  },
  /** Comma-separated message ids for dump scripts (`WEQ_TEST_MSG_IDS`). */
  get msgIds(): string {
    return optional('WEQ_TEST_MSG_IDS');
  },
  /** Fabricated uid for the fake-assistant fixtures (`WEQ_FAKE_UID`). */
  get fakeUid(): string {
    return optional('WEQ_FAKE_UID', 'u_WeQ-assistant-fake01');
  },
  /** Fabricated uin for the fake-assistant fixtures (`WEQ_FAKE_UIN`). */
  get fakeUin(): string {
    return optional('WEQ_FAKE_UIN', '2233445566');
  },

  // ---- Write-guard flags for destructive scripts ------------------------
  /** `WEQ_DRY_RUN=1` → script should not write to the DB. */
  get dryRun(): boolean {
    return flag('WEQ_DRY_RUN');
  },
  /** `WEQ_RESTORE=1` → script should undo/restore instead of mutate. */
  get restore(): boolean {
    return flag('WEQ_RESTORE');
  },
  /** `WEQ_WRITE_PROFILE=1` → allow writing profile rows. */
  get writeProfile(): boolean {
    return flag('WEQ_WRITE_PROFILE');
  },
} as const;

/** Escape hatch for the rare script that reads a bespoke variable. */
export { optional as envOptional, required as envRequired, flag as envFlag };
