// @vitest-environment node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

function configObject(path: string): ts.ObjectLiteralExpression {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const exported = file.statements.find(ts.isExportAssignment);
  if (!exported || !ts.isCallExpression(exported.expression)) throw new Error('缺少 defineConfig');
  const config = exported.expression.arguments[0];
  if (!config || !ts.isObjectLiteralExpression(config)) throw new Error('缺少配置对象');
  return config;
}
function property(object: ts.ObjectLiteralExpression, key: string): ts.Expression {
  const prop = object.properties.find(
    (entry) => ts.isPropertyAssignment(entry) && entry.name.getText() === key,
  );
  if (!prop || !ts.isPropertyAssignment(prop)) throw new Error(`缺少配置 ${key}`);
  return prop.initializer;
}
it('桌面三个构建目标均禁用清屏，启动和重载保留已有终端记录', () => {
  const config = configObject(resolve(__dirname, '../electron.vite.config.ts'));
  for (const target of ['main', 'preload', 'renderer']) {
    const value = property(config, target);
    if (!ts.isObjectLiteralExpression(value)) throw new Error('缺少目标配置');
    expect(property(value, 'clearScreen').kind, target).toBe(ts.SyntaxKind.FalseKeyword);
  }
});
it('内置 Web 的独立 Vite 构建同样禁用清屏', () => {
  const config = configObject(resolve(__dirname, '../../web/vite.config.ts'));
  expect(property(config, 'clearScreen').kind).toBe(ts.SyntaxKind.FalseKeyword);
});
it('Vite 配置不再依赖打包加载器注入的 __dirname', () => {
  for (const path of ['../electron.vite.config.ts', '../../web/vite.config.ts']) {
    expect(readFileSync(resolve(__dirname, path), 'utf8')).not.toMatch(/\b__dirname\b/);
  }
});
it.each([
  [
    'desktop',
    "const {config} = await (await import('electron-vite')).loadConfigFromFile({command:'build', mode:'development'}); assert.equal(realpathSync(config.renderer.root), realpathSync('src/renderer'));",
  ],
  [
    'web',
    "const config = await (await import('vite')).resolveConfig({}, 'build'); assert.equal(realpathSync(config.root), realpathSync('../desktop/src/renderer'));",
  ],
])(
  '%s 真实配置加载无弃用或原生加载器兼容提醒，路径仍指向源码',
  (target, code) => {
    const result = spawnSync(
      process.execPath,
      [
        '--throw-deprecation',
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict'; import { realpathSync } from 'node:fs'; ${code}`,
      ],
      {
        cwd: resolve(__dirname, '../../', target),
        env: { ...process.env, WEQ_DEV_CONSOLE: '1', WEQ_LOG_LEVEL: 'info' },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('DeprecationWarning');
    expect(result.stderr).not.toContain("unsupported by `configLoader: 'native'`");
  },
  20_000,
);
