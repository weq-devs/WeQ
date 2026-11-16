import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../src/renderer/src');

function buttonClass(file: string, marker: string): string {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'button') {
      const attributes = node.openingElement.attributes.properties;
      const className = attributes.find(
        (attribute) =>
          ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'className',
      );
      if (node.getText(source).includes(marker) && className) found.push(className.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(found, `${file}: ${marker} 应唯一定位按钮`).toHaveLength(1);
  return found[0]!;
}

it.each([
  ['components/settings/DatabaseManagementSection.tsx', '打开数据库浏览'],
  ['components/settings/ResourceManagementSection.tsx', "setView('browse')"],
  ['components/settings/RemotePanel.tsx', 'onClick={onCopy}'],
  ['components/settings/McpServerSection.tsx', 'copiedConfig'],
  ['components/settings/OneBotSection.tsx', 'copy(ccConnectConfig)'],
  ['components/settings/BackupSection.tsx', 'setPreview(null)}'],
  ['components/QqDebugCopyPermissions.tsx', 'onClick={onClose}'],
  ['components/RestrictedQqAction.tsx', 'setSettingsOpen(true)'],
  ['components/RestrictedQqAction.tsx', 'onRetry()'],
])('普通入口和辅助操作不显式升级为主动作：%s', (file, marker) => {
  expect(buttonClass(file!, marker!)).not.toContain('weq-set-btn-primary');
});

it.each([
  ['components/settings/VoiceTranscribeSection.tsx', 'onSave()'],
  ['components/settings/AgentLabSection.tsx', 'onSave()'],
  ['components/settings/OneBotSection.tsx', 'saveServer.isLoading'],
  ['components/settings/ExternalRkeySection.tsx', '<Save size={13}'],
  ['components/settings/SsePushSection.tsx', '<Save size={13}'],
  ['components/settings/TypingStatusSettingsCard.tsx', 'onSave()'],
  ['components/settings/BackupSection.tsx', '导出备份'],
  ['components/settings/BackupSection.tsx', '确认恢复'],
  ['components/settings/RemotePanel.tsx', 'onDecide(request.id, true)'],
  ['components/tasks/ScheduleSettings.tsx', '保存设置'],
  ['components/qq-actions/GroupJoinSettings.tsx', '保存加群方式'],
  ['views/agentlab/NewGroupModal.tsx', 'onCreate('],
  ['views/agentlab/NewCloneModal.tsx', 'onStartClick'],
])('提交和流程主动作显式声明主题色：%s', (file, marker) => {
  expect(buttonClass(file!, marker!)).toContain('weq-set-btn-primary');
});

it('副本准备和启动按当前流程只强调一个主动作', () => {
  expect(buttonClass('components/QqDebugCopy.tsx', "run('prepare')")).toContain(
    "!ready ? ' weq-set-btn-primary' : ''",
  );
  expect(buttonClass('components/QqDebugCopy.tsx', "run('launch')")).toContain(
    "ready ? ' weq-set-btn-primary' : ''",
  );
});
