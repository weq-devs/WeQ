// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../src/renderer/src/', import.meta.url));
const buttons: { file: string; label: string; danger?: string }[] = [];
const menus: { file: string; label: string; danger: string }[] = [];
for (const file of readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.tsx'))) {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = open.tagName.getText(source);
      if (['button', 'ActionIcon', 'CompositionButton'].includes(tag)) {
        const attrs = open.attributes.properties.filter(ts.isJsxAttribute);
        const attr = (name: string) =>
          attrs.find((attr) => attr.name.getText(source) === name)?.initializer;
        const children = ts.isJsxElement(node)
          ? node.children
              .map((child) =>
                ts.isJsxText(child)
                  ? child.text
                  : ts.isJsxExpression(child)
                    ? (child.expression?.getText(source) ?? '')
                    : child.getText(source).replace(/<[^>]+>/g, ''),
              )
              .join(' ')
          : '';
        const danger = attr('data-danger') ?? attr('danger');
        buttons.push({
          file,
          label: [
            attr('label')?.getText(source),
            attr('title')?.getText(source),
            attr('aria-label')?.getText(source),
            children,
          ]
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
          danger: danger && ts.isStringLiteral(danger) ? danger.text : undefined,
        });
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const property = (name: string) =>
        node.properties.find(
          (item): item is ts.PropertyAssignment =>
            ts.isPropertyAssignment(item) && item.name.getText(source) === name,
        );
      const label = property('label')?.initializer;
      const danger = property('danger')?.initializer;
      if (
        property('action') &&
        label &&
        ts.isStringLiteral(label) &&
        danger &&
        ts.isStringLiteral(danger)
      )
        menus.push({ file, label: label.text, danger: danger.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

it('显式危险色只标记实际破坏或覆盖操作，不误标同位置的普通按钮', () => {
  const misplaced = buttons.filter(
    (button) =>
      button.danger &&
      !(
        button.file === 'components/qq-actions/GroupActions.tsx' &&
        button.label.startsWith('{exit.label} ')
      ) &&
      !/删除|清|重置|恢复|移除|撤|踢|拒|解除|回滚|修复|放弃|默认|退出群/.test(button.label),
  );
  expect(misplaced).toEqual([]);
  expect(menus.filter((menu) => !/删除|移除/.test(menu.label))).toEqual([]);
  for (const [file, label] of [
    ['views/mail/MailPage.tsx', '标为未读'],
    ['components/settings/AgentLabSection.tsx', '测试连通性'],
  ])
    expect(
      buttons
        .filter((button) => button.file === file && button.label.includes(label))
        .map((button) => button.danger),
    ).toEqual([undefined]);
});

it.each([
  ['components/settings/ClearReadRecordsSetting.tsx', '清除 WeQ 已读记录', 'outline'],
  ['components/settings/BackupSection.tsx', '恢复全局默认设置', 'solid'],
  ['views/mail/MailPage.tsx', '删除当前邮件', 'outline'],
  ['views/agentlab/AssistantMenuWorkspace.tsx', '删除会话', 'outline'],
  ['views/agentlab/PersonaSettingsModal.tsx', '删除克隆体', 'solid'],
  ['views/agentlab/GroupChatPanel.tsx', '删除整个群聊', 'solid'],
  ['views/analysis/AnalysisReportsTool.tsx', '删除报告', 'outline'],
  ['components/GroupFileManager.tsx', '删除所选项目', 'outline'],
  ['components/qq-actions/GroupAlbumManagement.tsx', '删除相册', 'solid'],
  ['components/qq-actions/MediaActions.tsx', '删除相册媒体', 'outline'],
  ['components/settings/AgentLabSection.tsx', '删除模型', 'outline'],
  ['components/settings/GlobalSettingsSection.tsx', '清除默认进入账号', 'outline'],
  ['components/settings/VoiceTranscribeSection.tsx', '删除', 'outline'],
  ['components/ConversationSelectionToolbar.tsx', '永久删除所选 AI 会话', 'solid'],
])('%s 的 %s 使用 %s 级别', (file, label, danger) => {
  const matches = buttons.filter((button) => button.file === file && button.label.includes(label));
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.every((button) => button.danger === danger)).toBe(true);
});

it.each([
  ['永久删除', 'solid'],
  ['删除分组', 'outline'],
])('会话目录菜单的 %s 使用 %s 级别，不把属性写成界面正文', (label, danger) => {
  expect(
    menus.filter(
      (menu) => menu.file === 'im-template/template/conversationLists.tsx' && menu.label === label,
    ),
  ).toEqual([{ file: 'im-template/template/conversationLists.tsx', label, danger }]);
  expect(
    readFileSync(join(root, 'im-template/template/conversationLists.tsx'), 'utf8'),
  ).not.toMatch(/\) : null}\s*danger:/);
});
