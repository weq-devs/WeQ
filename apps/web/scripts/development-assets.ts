import type { Plugin } from 'vite';

/** 完整源码映射留在 Vite 模块图中，调试器按需获取，不随运行模块内联传给手机。 */
export function developmentSourceMaps(): Plugin {
  return {
    name: 'weq-development-source-maps',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const end = res.end;
        // Node 的 end 重载共用相同参数转发，只有字符串模块响应会被替换。
        res.end = function (this: typeof res, ...args: Parameters<typeof end>) {
          const [body] = args;
          const match =
            typeof body === 'string' &&
            String(res.getHeader('Content-Type')).startsWith('text/javascript') &&
            /\n\/\/# sourceMappingURL=data:application\/json;base64,[A-Za-z0-9+/=]+\s*$/.exec(body);
          if (!match) return end.apply(this, args);
          void server.environments.client.moduleGraph
            .getModuleByUrl(req.url ?? '/')
            .then((module) => {
              if (res.destroyed) return;
              const url = new URL(req.url ?? '/', 'http://weq.invalid');
              url.pathname += '.map';
              const map = module?.transformResult?.map;
              // 未转换 JS 的 fallback 不在模块图中，原文件也无需再取映射。
              const suffix = map?.mappings
                ? `\n//# sourceMappingURL=${url.pathname}${url.search}`
                : '';
              res.removeHeader('Content-Length');
              args[0] = body.slice(0, match.index) + suffix;
              end.apply(this, args);
            })
            .catch((error: Error) => res.destroy(error));
          return this;
        } as typeof end;
        next();
      });
    },
  };
}
