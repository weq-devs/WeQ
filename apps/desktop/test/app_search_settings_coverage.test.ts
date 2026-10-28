// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  APP_SEARCH_ENTRIES,
  searchAppEntries,
} from '../src/renderer/src/components/search/appSearchCatalog';

// 从实际控件取名称，避免覆盖测试和目录共同抄漏同一个新增选项。
const pages = {
  CallRecordingSection: 'call-recording',
  QzoneSettingsSection: 'qzone',
  RemotePanel: 'remote',
  RemoteSection: 'remote',
  StartupSection: 'startup',
  McpServerSection: 'mcp',
  AssistantSection: 'assistant',
  PrivacySection: 'privacy',
  ChatImageCacheSettings: 'chat-messages',
} as const;

describe('功能目录与真实设置控件同步', () => {
  it('导出菜单与搜索种类双向覆盖，移除的种类不会继续出现在搜索目标中', () => {
    const url = new URL('../src/renderer/src/views/ExportView.tsx', import.meta.url);
    const source = ts.createSourceFile(
      'ExportView.tsx',
      readFileSync(url, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const modes = new Set<string>();
    function visit(node: ts.Node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'MODES' &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        for (const item of node.initializer.elements) {
          if (!ts.isObjectLiteralExpression(item)) continue;
          for (const prop of item.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              prop.name.getText(source) === 'id' &&
              ts.isStringLiteral(prop.initializer)
            )
              modes.add(prop.initializer.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(modes.size).toBeGreaterThan(0);
    const indexed = new Set<string>(
      APP_SEARCH_ENTRIES.flatMap((entry) =>
        entry.target.kind === 'tool' && entry.target.exportMode ? [entry.target.exportMode] : [],
      ),
    );
    for (const mode of modes) expect(indexed.has(mode), `菜单种类未收录: ${mode}`).toBe(true);
    // 定时执行沿用聊天消息面板，不再单独占菜单项。
    for (const mode of indexed)
      expect(mode === 'scheduled' || modes.has(mode), `搜索种类已过时: ${mode}`).toBe(true);
  });
  it.each(Object.entries(pages))('%s 的公开设置行可在所属页面检索', (file, section) => {
    const url = new URL(`../src/renderer/src/components/settings/${file}.tsx`, import.meta.url);
    const source = ts.createSourceFile(
      file,
      readFileSync(url, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const labels: string[] = [];
    function visit(node: ts.Node) {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(source) === 'Row'
      ) {
        for (const attr of node.attributes.properties) {
          if (
            ts.isJsxAttribute(attr) &&
            attr.name.getText(source) === 'label' &&
            attr.initializer &&
            ts.isStringLiteral(attr.initializer)
          )
            labels.push(attr.initializer.text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(
        searchAppEntries(label).some(
          (entry) => entry.target.kind === 'setting' && entry.target.section === section,
        ),
        `${file}: ${label}`,
      ).toBe(true);
    }
  });
});
