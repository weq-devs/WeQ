import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { verifyPackagedRemoteNetwork } from './package-remote-network.mjs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  installedNativeManifest,
  verifyPackagedAuthorization,
} from './check-authorization-helper.mjs';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { Arch } = require('electron-builder');
const ts = require('typescript');

function fileHash(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(file, 'r');
  try {
    for (;;) {
      const length = readSync(fd, buffer, 0, buffer.length, null);
      if (length === 0) break;
      hash.update(buffer.subarray(0, length));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** 仅在同目录只有一个完整版本且字节相同时替换别名，不跨版本共享运行库。 */
export function deduplicateOnnxLibraries(directory) {
  if (!existsSync(directory)) return 0;
  const targets = readdirSync(directory).filter((name) =>
    /^libonnxruntime\.\d+\.\d+\.\d+\.dylib$/.test(name),
  );
  if (targets.length !== 1) return 0;
  const target = join(directory, targets[0]);
  if (!lstatSync(target).isFile()) return 0;
  const size = statSync(target).size;
  const hash = fileHash(target);
  const major = targets[0].split('.')[1];
  let saved = 0;
  for (const name of ['libonnxruntime.dylib', `libonnxruntime.${major}.dylib`]) {
    const alias = join(directory, name);
    if (!existsSync(alias) || !lstatSync(alias).isFile()) continue;
    if (statSync(alias).size !== size || fileHash(alias) !== hash) continue;
    const temporary = `${alias}.weq-link`;
    symlinkSync(basename(target), temporary);
    renameSync(temporary, alias);
    saved += size;
  }
  return saved;
}

/** 由实际复制出的 worker 入口求闭包；先验证全部依赖，再删除无关 JS chunks。 */
export function pruneWorkerChunks(mainDirectory) {
  const root = resolve(mainDirectory);
  const chunks = join(root, 'chunks');
  if (!existsSync(chunks)) return 0;
  const entries = readdirSync(root).filter((name) => /\.[cm]?js$/.test(name));
  if (entries.length === 0) return 0;
  const kept = new Set();
  function visit(file) {
    if (!file.startsWith(`${root}${sep}`)) throw new Error(`worker 导入超出产物目录：${file}`);
    if (kept.has(file)) return;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    if (source.parseDiagnostics.length) throw new Error(`无法解析 worker 模块：${file}`);
    kept.add(file);
    function follow(node) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (isAbsolute(node.text) || node.text.startsWith('file:'))
          throw new Error(`worker 导入不是包内相对路径：${node.text}`);
        if (node.text.startsWith('.')) visit(resolve(dirname(file), node.text));
      } else {
        throw new Error(`worker 含计算式 import，无法安全裁剪：${file}`);
      }
    }
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        follow(node.moduleSpecifier);
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) follow(node.arguments[0]);
        else if (
          node.arguments?.[0] &&
          ts.isStringLiteral(node.arguments[0]) &&
          ((ts.isIdentifier(node.expression) && /require/i.test(node.expression.text)) ||
            (node.arguments[0].text.startsWith('.') && /\.[cm]?js$/.test(node.arguments[0].text)))
        )
          // 也保留重命名加载器、new URL 等调用中显式提到的相对 JS 文件。
          follow(node.arguments[0]);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  for (const entry of entries) visit(join(root, entry));
  let saved = 0;
  function prune(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) prune(file);
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name) && !kept.has(file)) {
        saved += statSync(file).size;
        rmSync(file);
      }
    }
  }
  prune(chunks);
  return saved;
}

export function verifyDesktopAuthorization(context, beforeSigning = false) {
  if (process.env.WEQ_REQUIRE_AUTHORIZATION_HELPER !== '1') return;
  const arch = Arch[context.arch];
  if (!arch) throw new Error(`未知打包架构：${context.arch}`);
  const platform = context.electronPlatformName;
  const appDirectory =
    platform === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      : context.appOutDir;
  const manifest = installedNativeManifest();
  verifyPackagedAuthorization(appDirectory, `${platform}-${arch}`, {
    required: true,
    manifest,
    beforeSigning,
  });
}

/** 只修改本轮打包目录，且在最终签名前清理不属于目标平台的原生绑定。 */
export function trimDesktopPackage(context) {
  verifyDesktopAuthorization(context, true);
  const arch = Arch[context.arch];
  if (!arch) throw new Error(`未知打包架构：${context.arch}`);
  const platform = context.electronPlatformName;
  const resources =
    platform === 'darwin'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents/Resources',
        )
      : join(context.appOutDir, 'resources');
  verifyPackagedRemoteNetwork(context, resources);
  for (const candidate of ['arm64', 'x64']) {
    if (platform === 'darwin' && (candidate === arch || arch === 'universal')) continue;
    rmSync(
      join(resources, 'app.asar.unpacked/node_modules/@resvg', `resvg-js-darwin-${candidate}`),
      { recursive: true, force: true },
    );
  }
  pruneWorkerChunks(join(resources, 'out/main'));
  if (platform === 'darwin') {
    deduplicateOnnxLibraries(
      join(resources, 'node_modules/onnxruntime-node/bin/napi-v6/darwin', arch),
    );
    deduplicateOnnxLibraries(
      join(resources, 'app.asar.unpacked/node_modules', `sherpa-onnx-darwin-${arch}`),
    );
  }
}

export default trimDesktopPackage;
