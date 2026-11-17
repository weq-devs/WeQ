import { gzipSync } from 'node:zlib';
import type { Plugin, Rolldown } from 'vite';

type Chunk = Rolldown.OutputChunk & { viteMetadata?: { importedCss: Set<string> } };

/** 首屏代码和尺寸在构建时确定；手机连接不再现场压缩，也不等待账号请求后才发现依赖。 */
export function remoteStartupAssets(): Plugin {
  return {
    name: 'weq-remote-startup-assets',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const chunks = Object.values(bundle).filter((item) => item.type === 'chunk') as Chunk[];
        const entry = chunks.find(
          (chunk) => chunk.isEntry && chunk.facadeModuleId?.endsWith('/index.html'),
        );
        const workspace = chunks.find((chunk) =>
          Object.keys(chunk.modules).some((id) => id.endsWith('/views/MainView.tsx')),
        );
        if (!entry || !workspace) this.error('首屏资源清单缺少网页或主工作区入口');
        const collect = (name: string, names = new Set<string>()): Set<string> => {
          if (names.has(name)) return names;
          const item = bundle[name];
          if (!item) return names;
          names.add(name);
          if (item.type === 'chunk') {
            for (const dependency of item.imports) collect(dependency, names);
            for (const css of (item as Chunk).viteMetadata?.importedCss ?? []) collect(css, names);
          }
          return names;
        };
        const initial = collect(entry.fileName);
        const required = collect(workspace.fileName, new Set(initial));
        // 默认首页也是独立模块；不能在工作区挂载后才再次开始下载。
        const home = chunks.find((chunk) =>
          Object.keys(chunk.modules).some((id) => id.endsWith('/views/ChatHome.tsx')),
        );
        if (home) collect(home.fileName, required);
        const resources = [...required]
          .filter((name) => /^assets\/[^/]+\.(?:js|css)$/.test(name))
          .map((name) => {
            const item = bundle[name]!;
            const body = Buffer.from(item.type === 'chunk' ? item.code : item.source);
            return {
              path: `/${name}`,
              raw: body.length,
              gzip: body.length >= 1024 ? gzipSync(body).length : body.length,
              preload: !initial.has(name),
            };
          });
        this.emitFile({
          type: 'asset',
          fileName: 'weq-startup.json',
          source: JSON.stringify({
            version: 1,
            entry: `/${entry.fileName}`,
            resources,
          }),
        });
      },
    },
  };
}
