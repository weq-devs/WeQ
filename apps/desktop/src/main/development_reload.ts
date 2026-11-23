import { randomUUID } from 'node:crypto';
import type { HotPayload, Plugin } from 'vite';
import {
  DEVELOPMENT_RELOAD_APPLY,
  DEVELOPMENT_RELOAD_QUERY,
  DEVELOPMENT_RELOAD_STATUS,
  type DevelopmentReloadStatus,
} from '../shared/development_reload';
import { DEVELOPMENT_MENU_RESTART } from './development_restart';

type Target = 'main' | 'preload';

/** 构建只登记待更新，原 electron-vite 重载回调在用户点击后执行。 */
export function createDevelopmentReload() {
  let id: string | undefined;
  let page: (() => void) | undefined;
  let applying = false;
  const callbacks = new Map<Target, () => void>();
  const unavailable = new Set<Target>();
  const listeners = new Set<() => void>();
  const status = (): DevelopmentReloadStatus | null =>
    id ? { id, restart: callbacks.has('main'), ready: unavailable.size === 0 } : null;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const clear = () => {
    if (!id) return;
    id = undefined;
    callbacks.clear();
    page = undefined;
    notify();
  };
  const controller = {
    status,
    building(target: Target) {
      unavailable.add(target);
      notify();
    },
    failed(target: Target) {
      unavailable.add(target);
      notify();
    },
    built(target: Target, apply: () => void) {
      unavailable.delete(target);
      id ??= randomUUID();
      callbacks.set(target, apply);
      notify();
    },
    apply(requestId: unknown) {
      if (!id || id !== requestId || unavailable.size || applying) return;
      const apply = callbacks.get('main') ?? callbacks.get('preload') ?? page;
      clear();
      applying = true;
      try {
        apply?.();
      } finally {
        applying = false;
      }
    },
    rendererPlugin({ clearOnMenuRestart = false } = {}): Plugin {
      return {
        name: 'weq-development-reload-prompt',
        apply: 'serve',
        configureServer(server) {
          const send = server.ws.send.bind(server.ws);
          const publish = () => send(DEVELOPMENT_RELOAD_STATUS, status());
          listeners.add(publish);
          // 在 Vite 客户端收到 full-reload 之前拦截；beforeFullReload 不是可取消事件。
          server.ws.send = ((payload: HotPayload | string, data?: unknown) => {
            if (
              typeof payload !== 'string' &&
              payload.type === 'full-reload' &&
              !payload.ifFallback &&
              !applying
            ) {
              // 新连接的临时分包页没有更新横幅，只让这类页面立即转入实际页面。
              if (server.config.experimental.bundledDev) send({ ...payload, ifFallback: true });
              id ??= randomUUID();
              page = () => send(payload);
              notify();
            } else if (typeof payload === 'string') send(payload, data);
            else send(payload);
          }) as typeof server.ws.send;
          server.ws.on(DEVELOPMENT_RELOAD_QUERY, (_data, client) => {
            client.send(DEVELOPMENT_RELOAD_STATUS, status());
          });
          server.ws.on(DEVELOPMENT_RELOAD_APPLY, (data: { id?: unknown }, client) => {
            controller.apply(data?.id);
            client.send(DEVELOPMENT_RELOAD_STATUS, status());
          });
          if (clearOnMenuRestart) process.on(DEVELOPMENT_MENU_RESTART, clear);
          server.httpServer?.once('close', () => {
            listeners.delete(publish);
            if (clearOnMenuRestart) process.off(DEVELOPMENT_MENU_RESTART, clear);
          });
        },
      };
    },
  };
  return controller;
}

/** 旧进程仍会按需导入带哈希的分块；只在监听器首次构建时清理旧产物。 */
export function retainDevelopmentMainChunks(): Plugin {
  return {
    name: 'weq-retain-development-main-chunks',
    apply: 'build',
    writeBundle() {
      const { build } = this.environment.config;
      if (build.watch) build.emptyOutDir = false;
    },
  };
}

/** electron-vite 6 的 closeBundle 在失败构建后也触发；只有实际写出产物才允许重启／刷新。 */
export function successfulDevelopmentReload(
  target?: Target,
  deferred?: ReturnType<typeof createDevelopmentReload>,
): Plugin {
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
          if (!emitted) {
            if (target && loaded) deferred?.failed(target);
            return;
          }
          const incremental = loaded;
          const apply = () => {
            if (target === 'main' && incremental && process.env.WEQ_DEV_CONSOLE === '1') {
              process.env.WEQ_DEV_RESTART = '1';
              process.env.WEQ_DEV_STARTED_AT = String(Date.now());
            }
            return handler.call(this);
          };
          if (target && loaded && deferred) return deferred.built(target, apply);
          loaded = true;
          return apply();
        },
      };
    },
    buildStart() {
      emitted = false;
      if (target && loaded) deferred?.building(target);
    },
    writeBundle() {
      emitted = true;
    },
  };
}
