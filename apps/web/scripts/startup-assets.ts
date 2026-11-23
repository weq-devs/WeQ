import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Plugin, Rolldown } from 'vite';
import { hashedWebCodePath } from '../../desktop/src/main/web/compression.ts';

type Chunk = Rolldown.OutputChunk & { viteMetadata?: { importedCss: Set<string> } };

function staticAssets(
  bundle: Rolldown.OutputBundle,
  name: string,
  names = new Set<string>(),
): Set<string> {
  const item = bundle[name];
  if (!item || names.has(name)) return names;
  names.add(name);
  if (item.type === 'chunk') {
    for (const dependency of item.imports) staticAssets(bundle, dependency, names);
    for (const css of (item as Chunk).viteMetadata?.importedCss ?? [])
      staticAssets(bundle, css, names);
  }
  return names;
}

/** 打包热更新的入口和静态依赖随同一份 HTML 发布，按构建后的原始字节加权。 */
export function developmentStartupAssets(): Plugin {
  return {
    name: 'weq-development-startup-assets',
    apply: (_config, { command }) => command === 'serve',
    enforce: 'post',
    applyToEnvironment: (environment) =>
      environment.name === 'client' && environment.config.isBundled,
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const html = bundle['index.html'];
        if (html?.type !== 'asset' || typeof html.source !== 'string') return;
        const entry = Object.values(bundle).find(
          (item) =>
            item.type === 'chunk' && item.isEntry && item.facadeModuleId?.endsWith('/index.html'),
        );
        if (!entry) return;
        const resources = [...staticAssets(bundle, entry.fileName)]
          .filter((name) => /^assets\/[\w.-]+\.(?:js|css)$/.test(name))
          .map((name) => {
            const item = bundle[name]!;
            return {
              path: `/${name}`,
              size: Buffer.byteLength(item.type === 'chunk' ? item.code : item.source),
            };
          });
        if (!resources.length) return;
        const meta = `<meta name="weq-development-startup-resources" content='${JSON.stringify({ version: 1, resources })}'>`;
        const required = staticAssets(bundle, entry.fileName);
        for (const chunk of Object.values(bundle)) {
          if (
            chunk.type === 'chunk' &&
            Object.keys(chunk.modules).some((id) =>
              /\/(?:views\/(?:MainView|ChatHome)|components\/(?:QqMarkdownContent|OfficialConversationPane))\.tsx$/.test(
                id,
              ),
            )
          )
            staticAssets(bundle, chunk.fileName, required);
        }
        const revision = createHash('sha256');
        const offline = [...required]
          .filter((name) => /^assets\/[\w.-]+\.(?:js|css)$/.test(name))
          .sort()
          .map((name) => {
            const item = bundle[name]!;
            revision.update(name).update(item.type === 'chunk' ? item.code : item.source);
            return { path: `/${name}` };
          });
        const offlineMeta = `<meta name="weq-offline-bundle" content='${JSON.stringify({
          version: 1,
          waitForWorkspace: true,
          revision: revision.digest('hex'),
          resources: [
            ...offline,
            { path: '/bundledDevClient.mjs' },
            { path: '/@rolldown/experimental-runtime.mjs' },
          ],
        })}'>`;
        html.source = html.source.replace(/<head\b[^>]*>/i, (head) => head + meta + offlineMeta);
      },
    },
  };
}

/** 首屏和离线工作区共用构建清单，设备进入账号后才加载工作区依赖。 */
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
        const initial = staticAssets(bundle, entry.fileName);
        const required = staticAssets(bundle, workspace.fileName, new Set(initial));
        // 默认首页也是独立模块；不能在工作区挂载后才再次开始下载。
        const home = chunks.find((chunk) =>
          Object.keys(chunk.modules).some((id) => id.endsWith('/views/ChatHome.tsx')),
        );
        if (home) staticAssets(bundle, home.fileName, required);
        const resources = [...required]
          .filter((name) => /^assets\/[^/]+\.(?:js|css)$/.test(name))
          .map((name) => {
            const item = bundle[name]!;
            const body = Buffer.from(item.type === 'chunk' ? item.code : item.source);
            const gzip = body.length >= 1024 ? gzipSync(body) : undefined;
            if (gzip && hashedWebCodePath.test(`/${name}`)) {
              this.emitFile({ type: 'asset', fileName: `${name}.gz`, source: gzip });
            }
            return {
              path: `/${name}`,
              raw: body.length,
              gzip: gzip?.length ?? body.length,
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
            offline: Object.keys(bundle)
              .filter((name) => /^assets\/[a-zA-Z0-9_.-]+\.(?:js|css|png|svg)$/.test(name))
              .sort()
              .map((path) => ({ path: `/${path}` })),
          }),
        });
      },
    },
  };
}
