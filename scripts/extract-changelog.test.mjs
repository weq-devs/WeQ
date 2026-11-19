import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSection } from './extract-changelog.mjs';

test('extractSection 原样保留发布正文，不混入其他版本', () => {
  const section = [
    '### 在时间里慢慢翻页',
    '',
    '- 父项',
    '    - 子项',
    '',
    '#### 补充说明',
    '第一行  ',
    '第二行',
    '',
    '**变更规模**：增加 123 行，删除 45 行。',
  ];
  const raw = [
    '# Changelog',
    '## Unreleased - 进行中',
    '- 尚未发布',
    '## 2.6.0 - 2026-11-10',
    '',
    ...section,
    '',
    '## 2.5.0 - 2026-11-06',
    '- 不属于 2.6.0',
  ].join('\n');

  assert.equal(extractSection(raw, 'v2.6.0'), section.join('\n'));
  assert.equal(extractSection(raw, '2.6.1'), '');
});
