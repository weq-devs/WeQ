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

import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// ---------------------------------------------------------------------------
// Android backup directory
// ---------------------------------------------------------------------------

/**
 * 手机 QQ 的数据库目录（`.../com.tencent.mobileqq/databases/nt_db/nt_qq_<hash>`）。
 * 结构跟 PC 的 `nt_db/` 一样是一堆 .db 平铺，但没有 `nt_data/`，而且密钥不用手输 ——
 * 目录里的 `gpro_v1-6_<uid>.db` 带着 uid，`nt_msg.db` 头部带着 rand，
 * `md5(md5(uid) + rand)` 就是 SQLCipher key（同 packages/account 的 deriveAndroidDbKey）。
 */
function androidRoot(): string {
  return required('WEQ_TEST_ANDROID_ROOT');
}

/** Absolute path to a database file under the android backup directory. */
export function androidDbPath(name: string): string {
  return path.join(androidRoot(), name);
}

const md5hex = (s: string): string => createHash('md5').update(s).digest('hex');

/** 目录名 `nt_qq_<md5(md5(uid) + "nt_kernel")>` 里的那个盐。 */
const ANDROID_DIR_SALT = 'nt_kernel';
/** QQ NT 在真正的 SQLite 页前塞的自定义头长度。 */
const ANDROID_HEADER_LEN = 1024;

/** uid 直接写在 `gpro_v1-6_<uid>.db` 的文件名里。 */
function androidUidFromDir(dir: string): string | undefined {
  for (const name of readdirSync(dir)) {
    const m = /^gpro_v[\d-]+_(u_[A-Za-z0-9_-]+)\.db$/.exec(name);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/** 自定义头里紧跟 `QQ_NT DB` 魔数的那段 8 字节可打印 ASCII。 */
function androidHeaderRand(dbPath: string): string | undefined {
  const buf = Buffer.alloc(ANDROID_HEADER_LEN);
  const fd = openSync(dbPath, 'r');
  try {
    if (readSync(fd, buf, 0, ANDROID_HEADER_LEN, 0) < ANDROID_HEADER_LEN) return undefined;
  } finally {
    closeSync(fd);
  }
  const magicAt = buf.indexOf('QQ_NT DB', 0, 'ascii');
  if (magicAt < 0) return undefined;
  const ascii = [...buf]
    .map((b) => (b >= 0x21 && b < 0x7f ? String.fromCharCode(b) : '\0'))
    .join('');
  for (const m of ascii.slice(magicAt + 8).matchAll(/[\x21-\x7e]+/g)) {
    if (m[0].length === 8) return m[0];
  }
  return undefined;
}

/** Everything an android-backup script needs; all derived from one env var. */
export const androidEnv = {
  /** The `nt_qq_<hash>` directory itself (`WEQ_TEST_ANDROID_ROOT`). */
  get dir(): string {
    return androidRoot();
  },
  /** `<dir>/nt_msg.db`. */
  get msgDbPath(): string {
    return androidDbPath('nt_msg.db');
  },
  /** `<dir>/profile_info.db`. */
  get profileDbPath(): string {
    return androidDbPath('profile_info.db');
  },
  /** uid read off the `gpro_v1-6_<uid>.db` filename. */
  get uid(): string {
    const uid = androidUidFromDir(androidRoot());
    if (!uid) throw new Error('[@weq/testkit] 安卓目录里没找到 gpro_v1-6_<uid>.db，无法取 uid');
    return uid;
  },
  /**
   * SQLCipher key, computed from uid + nt_msg.db 头部的 rand.
   * `WEQ_TEST_ANDROID_KEY` 可覆盖（比如目录被改名 / 头部格式变了）。
   */
  get key(): string {
    const override = optional('WEQ_TEST_ANDROID_KEY');
    if (override) return override;

    const dir = androidRoot();
    const uid = androidEnv.uid;
    const inner = md5hex(uid);

    const dirName = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    if (dirName.startsWith('nt_qq_') && dirName.slice(6) !== md5hex(inner + ANDROID_DIR_SALT)) {
      throw new Error(
        `[@weq/testkit] 目录名跟 uid 对不上（${dirName}），不是 uid 派生目录；` +
          '请用 WEQ_TEST_ANDROID_KEY 手动指定密钥。',
      );
    }

    const rand = androidHeaderRand(androidEnv.msgDbPath);
    if (!rand) {
      throw new Error('[@weq/testkit] nt_msg.db 头部读不出 8 字节 rand；请用 WEQ_TEST_ANDROID_KEY 指定密钥。');
    }
    return md5hex(inner + rand);
  },
} as const;


/**
 * Gate for every script under a `tools/mutate/` directory.
 *
 * These scripts write to the live QQ databases — an interrupted run can leave
 * rows half-written, and QQ itself may be holding the same file open. Requiring
 * an explicit `--yes` means a stray tab-complete can never mutate real data.
 *
 *   requireMutationConsent('往 group_msg_table 插入一条伪造消息');
 *
 * Bypass in automation with `WEQ_ASSUME_YES=1`.
 */
export function requireMutationConsent(whatItDoes: string): void {
  if (flag('WEQ_ASSUME_YES') || process.argv.includes('--yes')) return;

  throw new Error(
    '\n[写库守卫] 该脚本会修改真实的 QQ 数据库：\n' +
      `  ${whatItDoes}\n\n` +
      '  确认无误后重跑并加上 --yes：\n' +
      '    pnpm --filter <pkg> <script> --yes\n\n' +
      '  跑之前请先退出 QQ，否则可能写入失败或锁库。\n',
  );
}

export {
  ensureSendable,
  type EnsureSendableOptions,
  type InjectableNative,
} from './inject';
