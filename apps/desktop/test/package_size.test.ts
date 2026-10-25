// @vitest-environment node
import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { trimDesktopPackage } from '../../../scripts/trim-desktop-package.mjs';

const desktop = resolve(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const rendererOnly = [
  '@tanstack/react-query',
  '@trpc/react-query',
  'd3',
  'dompurify',
  'lottie-web',
  'react-dom',
  'react-icons',
  'remark-gfm',
  'shiki',
  'streamdown',
  'zustand',
];

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const { load } = appBuilderRequire('js-yaml') as { load: (source: string) => unknown };
type BuildFiles = { files?: (string | { filter: string[] })[] };
type Config = BuildFiles &
  Record<'mac' | 'win' | 'linux', BuildFiles> & {
    asarUnpack: string[];
    extraResources: { from: string; to: string }[];
  };
const rawConfig = load(readFileSync(join(desktop, 'electron-builder.yml'), 'utf8')) as Config;
const { doMergeConfigs } = builderRequire('app-builder-lib/out/util/config/config') as {
  doMergeConfigs: (configs: Config[]) => Config;
};
const config = doMergeConfigs([rawConfig]);
type Matcher = {
  createFilter: () => (path: string, stat: ReturnType<typeof statSync>) => boolean;
};
const { getNodeModuleFileMatcher, getMainFileMatchers, getFileMatchers } = builderRequire(
  'app-builder-lib/out/fileMatcher',
) as {
  getFileMatchers: (...args: unknown[]) => Matcher[];
  getMainFileMatchers: (...args: unknown[]) => Matcher[];
  getNodeModuleFileMatcher: (
    source: string,
    destination: string,
    expand: (value: string) => string,
    platform: BuildFiles,
    packager: { config: BuildFiles; debugLogger: { isEnabled: boolean } },
  ) => Matcher;
};
const { Arch } = builderRequire('electron-builder') as { Arch: Record<string, number> };

describe('桌面发行包瘦身', () => {
  it('转写 JS 包与平台原生绑定共同解包，不再额外复制到不相邻的目录', () => {
    const unpack = getFileMatchers(config, 'asarUnpack', '/fixture/package', {
      defaultSrc: desktop,
      customBuildOptions: {},
      globalOutDir: '/fixture/output',
      macroExpander: (value: string) => value,
    })[0].createFilter();
    // 匹配器接收 pnpm 的真实源路径，而不是扁平化后的 ASAR 路径。
    const source = realpathSync(join(desktop, 'node_modules/sherpa-onnx-node/package.json'));
    expect(unpack(source, statSync(source))).toBe(true);
    expect(
      config.extraResources.some((entry) => entry.to === 'node_modules/sherpa-onnx-node'),
    ).toBe(false);
  });
  it('未知架构在修改产物前报错', () => {
    expect(() => trimDesktopPackage({ arch: -1 })).toThrow('未知打包架构');
  });

  it('前端构建依赖不进入生产依赖，保留动态 require 和子进程需要的模块', () => {
    for (const name of rendererOnly) {
      expect(manifest.dependencies, name).not.toHaveProperty(name);
      expect(manifest.devDependencies, name).toHaveProperty(name);
    }
    for (const name of [
      'electron-trpc',
      '@trpc/client',
      '@trpc/server',
      'react',
      'exceljs',
      'sharp',
      '@resvg/resvg-js',
      'onnxruntime-node',
      'onnxruntime-common',
      'sherpa-onnx-node',
      '@receptron/laya',
      '@huggingface/tokenizers',
      'ws',
    ]) {
      expect(manifest.dependencies, name).toHaveProperty(name);
    }
  });

  it('主进程和预加载不在运行时引用被迁移的前端包', () => {
    const references: string[] = [];
    function walk(directory: string) {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, item.name);
        if (item.isDirectory()) walk(file);
        else if (file.endsWith('.ts')) {
          const source = ts.createSourceFile(
            file,
            readFileSync(file, 'utf8'),
            ts.ScriptTarget.Latest,
          );
          function check(value: string) {
            if (rendererOnly.some((name) => value === name || value.startsWith(`${name}/`)))
              references.push(`${file}: ${value}`);
          }
          function visit(node: ts.Node) {
            if (
              ts.isImportDeclaration(node) &&
              !node.importClause?.isTypeOnly &&
              ts.isStringLiteral(node.moduleSpecifier)
            )
              check(node.moduleSpecifier.text);
            if (
              ts.isExportDeclaration(node) &&
              !node.isTypeOnly &&
              node.moduleSpecifier &&
              ts.isStringLiteral(node.moduleSpecifier)
            )
              check(node.moduleSpecifier.text);
            // 同时覆盖 requireFromHere 等自定义 createRequire 名称。
            if (
              ts.isCallExpression(node) &&
              node.arguments[0] &&
              ts.isStringLiteral(node.arguments[0])
            )
              check(node.arguments[0].text);
            ts.forEachChild(node, visit);
          }
          visit(source);
        }
      }
    }
    walk(join(desktop, 'src/main'));
    walk(join(desktop, 'src/preload'));
    expect(references).toEqual([]);
  });

  for (const platform of ['mac', 'win', 'linux'] as const) {
    for (const arch of ['arm64', 'x64']) {
      it(`${platform}/${arch} 配置归一化后只收集运行文件，不收进源码和旧产物`, () => {
        const expand = (value: string) => value.replaceAll(/\$\{arch\}/g, arch);
        const debugLogger = { isEnabled: false };
        const matchers = getMainFileMatchers(
          desktop,
          '/fixture/package',
          expand,
          config[platform],
          { info: { projectDir: desktop, buildResourcesDir: 'build', config, debugLogger } },
          '/fixture/output',
          false,
        );
        expect(matchers).toHaveLength(1);
        const stat = statSync(join(desktop, 'package.json'));
        const mainIncludes = (file: string) =>
          matchers[0].createFilter()(join(desktop, file), stat);
        expect(mainIncludes('out/main/index.js')).toBe(true);
        expect(mainIncludes('out/renderer/index.html')).toBe(true);
        expect(mainIncludes('out/types-node/index.d.ts')).toBe(false);
        expect(mainIncludes('out/types-web/index.d.ts')).toBe(false);
        expect(mainIncludes('package.json')).toBe(true);
        expect(mainIncludes('src/main/index.ts')).toBe(false);
        expect(mainIncludes('dist/preview.js')).toBe(false);
        expect(mainIncludes('release/old/mac-arm64/weQ.app/Contents/Resources/app.asar')).toBe(
          false,
        );
        const matcher = getNodeModuleFileMatcher(
          desktop,
          '/fixture/package',
          expand,
          config[platform],
          { config, debugLogger: { isEnabled: false } },
        ).createFilter();
        const includes = (file: string) => matcher(join(desktop, file), stat);
        expect(includes('node_modules/exceljs/dist/exceljs.min.js')).toBe(false);
        expect(includes('node_modules/exceljs/lib/doc/workbook.js')).toBe(true);
        expect(includes('node_modules/exceljs/excel.js')).toBe(true);
        expect(includes('node_modules/exceljs/LICENSE')).toBe(true);
        expect(includes('node_modules/exceljs/lib/doc/workbook.js.map')).toBe(false);
        expect(includes('node_modules/sharp/lib/index.js')).toBe(true);
        expect(includes('node_modules/zod/index.d.cts')).toBe(false);
        expect(includes(`node_modules/@resvg/resvg-js-linux-${arch}-gnu/resvgjs.node`)).toBe(true);
        expect(includes('node_modules/@resvg/resvg-js-win32-x64-msvc/resvgjs.node')).toBe(true);
      });

      it(`${platform}/${arch} 签名前仅移除非目标 Darwin 绑定，不碰其余资源`, () => {
        const directory = mkdtempSync(join(desktop, 'node_modules/.weq-package-test-'));
        const resources =
          platform === 'mac'
            ? join(directory, 'weQ.app/Contents/Resources')
            : join(directory, 'resources');
        const modules = join(resources, 'app.asar.unpacked/node_modules');
        const candidates = [
          '@resvg/resvg-js-darwin-arm64',
          '@resvg/resvg-js-darwin-x64',
          '@resvg/resvg-js-linux-x64-gnu',
          'sharp',
          'sherpa-onnx-darwin-arm64',
        ];
        try {
          for (const name of candidates) mkdirSync(join(modules, name), { recursive: true });
          trimDesktopPackage({
            appOutDir: directory,
            electronPlatformName:
              platform === 'mac' ? 'darwin' : platform === 'win' ? 'win32' : 'linux',
            arch: Arch[arch],
            packager: { appInfo: { productFilename: 'weQ' } },
          });
          for (const name of candidates) {
            const expected = name.includes('resvg-js-darwin-')
              ? platform === 'mac' && name.endsWith(`-${arch}`)
              : true;
            expect(readdirSync(modules, { recursive: true }).includes(name)).toBe(expected);
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
});
