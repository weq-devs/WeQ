import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { startupLog } from './dev-process.mjs';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve('electron-vite')).href);
const { DEVELOPMENT_MENU_RESTART, DEVELOPMENT_RESTART_EXIT_CODE } = await tsImport(
  '../apps/desktop/src/main/development_restart.ts',
  import.meta.url,
);
const { manualRestartArgs } = await tsImport(
  '../apps/desktop/src/main/startup_window.ts',
  import.meta.url,
);

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
process.env.ELECTRON_CLI_ARGS = JSON.stringify(args);
process.env.WEQ_DEV_RESTART_MANAGED = '1';

try {
  await createServer(
    {},
    {
      restartOnExit(code) {
        if (code !== DEVELOPMENT_RESTART_EXIT_CODE) return false;
        const current = JSON.parse(process.env.ELECTRON_CLI_ARGS);
        process.env.ELECTRON_CLI_ARGS = JSON.stringify(manualRestartArgs(['electron', ...current]));
        process.env.WEQ_DEV_RESTART = '1';
        process.env.WEQ_DEV_STARTED_AT = String(Date.now());
        process.emit(DEVELOPMENT_MENU_RESTART);
        startupLog('正在重启 WeQ 应用');
        return true;
      },
    },
  );
} catch (error) {
  console.error(error.stack ?? error);
  process.exit(1);
}
