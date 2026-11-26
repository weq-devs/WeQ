import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSection, previousStableTag } from './extract-changelog.mjs';

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
  assert.equal(extractSection(raw, 'Unreleased'), '- 尚未发布');
  assert.equal(extractSection(raw, '2.6.1'), '');
});

test('测试版和正式版比较同一个已公开的较早正式版本', () => {
  const raw = [
    '## Unreleased - 进行中',
    '## 4.0.0',
    '## 3.11.0',
    '## 3.10.1',
    '## 3.9.9-beta.1',
    '## 3.9.0',
    '## v3.10.0',
  ].join('\r\n');
  const published = ['v4.0.0', 'v3.11.0', 'v3.10.2', 'v3.10.0', 'v3.9.0'];

  assert.equal(previousStableTag(raw, 'v3.11.0-beta.2', published), 'v3.10.0');
  assert.equal(previousStableTag(raw, 'v3.11.0', published), 'v3.10.0');
  assert.equal(previousStableTag(raw, 'v3.9.0', published), '');
});
