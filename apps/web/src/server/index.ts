/**
 * Entry point for the browser-served WeQ.
 *
 * Assembles the same services the desktop app uses (`initAppContext` from
 * `apps/desktop/src/main`, which is Electron-free by construction), installs
 * the web {@link HostBridge}, then starts the HTTP + WebSocket server.
 *
 * Environment:
 *   WEQ_TOKEN       access token. Required when binding beyond loopback;
 *                   auto-generated (and printed) otherwise.
 *   WEQ_HOST        bind address (default 127.0.0.1). Set 0.0.0.0 to expose.
 *   WEQ_PORT        preferred port (default 7690). Probes forward if taken.
 *   WEQ_EXPORT_DIR  where exports/saves land (default <cwd>/weq-exports).
 *   WEQ_DATA_DIR    logs + app data (default <cwd>/weq-data).
 *   WEQ_NATIVE_DIR  override for the native/ bundle (see @weq/native loader).
 */

import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setHost, initLogger } from '@weq/service';
import { initAppContext } from '@weq/desktop/main/context/app_context';
import { appRouter } from '@weq/desktop/main/ipc/router';
import { AuthGate } from './auth';
import { createWebHost } from './host';
import { startServer } from './http';
import { createTrpcHandler, attachWsHandler } from './trpc_adapter';

const here = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.WEQ_HOST || '127.0.0.1';
const PORT = Number(process.env.WEQ_PORT || 7690);
const EXPORT_DIR = process.env.WEQ_EXPORT_DIR || join(process.cwd(), 'weq-exports');
const DATA_DIR = process.env.WEQ_DATA_DIR || join(process.cwd(), 'weq-data');
const PUBLIC_DIR = resolve(here, 'public');

const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

/**
 * Baked in by `scripts/build-server.mjs` (esbuild `define`). Running from
 * source leaves the identifier undeclared, so the lookup is guarded — a bare
 * reference would throw ReferenceError rather than yield undefined.
 */
declare const __WEQ_VERSION__: string;
const VERSION = ((): string => {
  try {
    return __WEQ_VERSION__;
  } catch {
    return '0.0.0-dev';
  }
})();

/**
 * Resolve the access token. Binding beyond loopback with an auto-generated
 * token would mean the only copy is a console line the operator may never
 * read — so in that case we refuse to start instead.
 */
function resolveToken(): string {
  const fromEnv = process.env.WEQ_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!isLoopback) {
    console.error(
      `\n拒绝启动：绑定到 ${HOST}（非本机回环）时必须显式设置 WEQ_TOKEN。\n` +
        `  例：WEQ_TOKEN=$(openssl rand -hex 24) WEQ_HOST=0.0.0.0 node server.mjs\n` +
        `远程暴露时请同时考虑放在 HTTPS 反向代理之后。\n`,
    );
    process.exit(1);
  }
  return randomBytes(24).toString('hex');
}

async function main(): Promise<void> {
  initLogger(DATA_DIR);

  const token = resolveToken();
  const generated = !process.env.WEQ_TOKEN?.trim();

  setHost(createWebHost({ exportDir: EXPORT_DIR, version: VERSION }));
  initAppContext();

  const auth = new AuthGate({ token, remote: !isLoopback });
  const { server, port } = await startServer({
    port: PORT,
    host: HOST,
    publicDir: PUBLIC_DIR,
    auth,
    trpc: createTrpcHandler(appRouter),
  });
  attachWsHandler(server, appRouter, auth);

  console.log(`\n  WeQ Web  →  http://${isLoopback ? '127.0.0.1' : HOST}:${port}`);
  if (generated) console.log(`  访问令牌  →  ${token}    (设置 WEQ_TOKEN 可固定)`);
  console.log(`  导出目录  →  ${EXPORT_DIR}\n`);

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[web] failed to start:', e);
  process.exit(1);
});
