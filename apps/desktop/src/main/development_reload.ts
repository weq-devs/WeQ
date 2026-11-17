import type { Plugin } from 'vite';

/** electron-vite 6 的 closeBundle 在失败构建后也触发；只有实际写出产物才允许重启／刷新。 */
export function successfulDevelopmentReload(target?: 'main' | 'preload'): Plugin {
  let emitted = false;
  let loaded = false;
  return {
    name: 'weq-successful-development-reload',
    apply: 'build',
    configResolved(config) {
      if (!config.build.watch) return;
      const watcher = config.plugins.find((plugin) => plugin.name === 'vite:electron-watcher');
      const original = watcher?.closeBundle;
      if (!watcher || !original)
        throw new Error('electron-vite 监听接口已变化，请核对开发重载适配');
      const handler = typeof original === 'function' ? original : original.handler;
      watcher.closeBundle = {
        ...(typeof original === 'object' ? original : {}),
        handler() {
          if (!emitted) return;
          if (target === 'main' && loaded && process.env.WEQ_DEV_CONSOLE === '1') {
            process.env.WEQ_DEV_RESTART = '1';
            process.env.WEQ_DEV_STARTED_AT = String(Date.now());
          }
          loaded = true;
          return handler.call(this);
        },
      };
    },
    buildStart() {
      emitted = false;
    },
    writeBundle() {
      emitted = true;
    },
  };
}
