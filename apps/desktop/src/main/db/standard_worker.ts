/**
 * Standard-SQLite worker — the stock-SQLite half of the DB split.
 *
 * SQLite's pager pending byte is process-global: the QQ layout reserves page
 * 262144 (file offset 0x3FFFFC00), while stock SQLite reserves page 262145
 * (0x40000000).  The main process is initialized as `qq` because SQLCipher is
 * the hot path; plain SQLite files are opened here instead, in a process where
 * `setDbLayout('standard')` is the first and only layout choice.
 *
 * This is a long-lived process (unlike the OCR / key-scan workers): the main
 * process keeps the native connection cache warm on this side too.
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import {
  isStandardDbMethod,
  serializeStandardDbError,
  type StandardDbRequest,
  type StandardDbResponse,
} from './protocol';

const requireFn = createRequire(__filename);

/** Only the surface this worker uses; the addon itself is much larger. */
interface StandardAddon {
  getInitStatus?: () => number;
  setDbLayout?: (layout: string) => void;
  [key: string]: unknown;
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function send(response: StandardDbResponse): void {
  if (typeof process.send !== 'function') return;
  process.send(response);
}

async function handle(nt: StandardAddon, raw: unknown): Promise<void> {
  const request = raw as Partial<StandardDbRequest> | null;
  if (!request || typeof request.id !== 'number' || !isStandardDbMethod(request.method)) {
    // Without a valid id there is nobody to answer; keep the worker alive and
    // report to stderr for diagnostics.
    process.stderr.write(`standardDbWorker: bad request ${String(raw)}\n`);
    return;
  }

  const fn = nt[request.method];
  if (typeof fn !== 'function') {
    send({
      id: request.id,
      ok: false,
      error: { name: 'Error', message: `nt_helper 缺少方法 ${request.method}` },
    });
    return;
  }

  try {
    const value = await (fn as (...args: unknown[]) => unknown).apply(nt, request.args ?? []);
    send({ id: request.id, ok: true, value });
  } catch (error) {
    send({ id: request.id, ok: false, error: serializeStandardDbError(error) });
  }
}

function main(): void {
  const ntHelperPath = process.argv[2];
  if (!ntHelperPath) fail('standardDbWorker: missing nt_helper.node path (argv[2])', 2);

  // The addon's LICENSE check walks up from cwd; keep the same contract as the
  // elevated workers.
  try {
    process.chdir(dirname(ntHelperPath));
  } catch (error) {
    fail(`standardDbWorker: chdir failed: ${String(error)}`, 2);
  }

  let nt: StandardAddon;
  try {
    nt = requireFn(ntHelperPath) as StandardAddon;
  } catch (error) {
    fail(`standardDbWorker: require nt_helper.node failed: ${String(error)}`, 1);
  }

  if (typeof nt.getInitStatus !== 'function' || nt.getInitStatus() !== 0) {
    fail('standardDbWorker: nt_helper initialization failed', 1);
  }

  if (typeof nt.setDbLayout !== 'function') {
    // Old artifact: stock SQLite's default pending byte is already correct, so
    // this lane still works. The QQ lane is the one that needs the new addon.
    process.stderr.write(
      'standardDbWorker: nt_helper.node lacks setDbLayout; using the default standard layout\n',
    );
  } else {
    try {
      nt.setDbLayout('standard');
    } catch (error) {
      fail(`standardDbWorker: setDbLayout(standard) failed: ${String(error)}`, 1);
    }
  }

  process.on('message', (message: unknown) => {
    void handle(nt, message);
  });
  // Parent gone → no reason to keep an orphan alive.
  process.on('disconnect', () => process.exit(0));
}

main();
