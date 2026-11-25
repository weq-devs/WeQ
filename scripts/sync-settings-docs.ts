import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGE_LABELS,
  listSettings,
} from '../packages/service/src/common/settings_catalog';
import { settingsResetScopeLabel } from '../packages/service/src/common/settings_catalog/reset';

const target = fileURLToPath(new URL('../docs/guide/settings-reference.md', import.meta.url));
const cell = (text: string) =>
  text.replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', ' ');
const lines = [
  '# 设置项参考',
  '',
  '<!-- 由 pnpm settings:docs 从设置注册表生成，请勿手工修改条目。 -->',
  '',
  '本清单与设置页面、全局搜索、恢复默认和 MCP 的 `list_settings` 共用设置注册表。名称与位置改变时，旧搜索别名和稳定 ID 继续用于定位。',
  '',
  '「页面恢复字段」列出该入口登记的恢复项；同一入口可以包含多个字段。空白表示该入口本身没有登记页面恢复操作，不表示全局恢复或其他业务流程会修改它。恢复时的实际范围与当前值以确认弹窗为准。',
  '',
  '使用方法见[设置总览](./settings.md)，维护方式见[设置注册表](../develop/settings-registry.md)。',
];
for (const group of SETTINGS_GROUPS) {
  lines.push('', `## ${group.label}`);
  for (const page of group.sections) {
    lines.push(
      '',
      `### ${SETTINGS_PAGE_LABELS[page]}`,
      '',
      '| 设置或入口 | 稳定 ID | 搜索别名 | 页面恢复字段 |',
      '| --- | --- | --- | --- |',
    );
    for (const item of listSettings({ page })) {
      lines.push(
        `| ${cell(item.label)} | \`${item.id}\` | ${cell(item.aliases.join('、'))} | ${cell(item.reset.map((field) => `${field.label}（${settingsResetScopeLabel(field.scope)}${field.directory ? '，目录需选择' : ''}${field.stopsService ? '，可能停用服务' : ''}）`).join('；'))} |`,
      );
    }
  }
}
const expected = `${lines.join('\n')}\n`;
if (process.argv.includes('--check')) {
  let actual = '';
  try {
    actual = readFileSync(target, 'utf8');
  } catch {
    /* 缺少生成页也应使检查失败。 */
  }
  if (actual !== expected) {
    console.error('设置参考页与注册表不同步，请运行 pnpm settings:docs');
    process.exitCode = 1;
  } else console.log('设置参考页与注册表一致');
} else {
  writeFileSync(target, expected);
  console.log(`已生成 ${listSettings().length} 个设置与入口的参考页`);
}
