import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeatureDefinition } from '../packages/service/src/common/feature_catalog';
import {
  readRegisteredTools,
  verifyFeatureReferences,
  verifyGeneratedReference,
} from './sync-feature-docs';

const tools = new Set(
  readRegisteredTools("const AI_TOOLS = [tool({ name: 'read_fixture' })];").keys(),
);
const feature: FeatureDefinition = {
  id: 'messages.fixture',
  label: '夹具',
  kind: 'feature',
  domain: 'messages',
  aliases: [],
  tools: ['read_fixture'],
  docs: ['guide/example.md#feature-messages.fixture'],
};
const page = 'guide/example.md';
const valid = new Map([[page, '<a id="feature-messages.fixture"></a>\n\n## 使用方法\n']]);

test('教程调整标题后可继续按功能 ID 定位，错误引用会失败', () => {
  assert.doesNotThrow(() => verifyFeatureReferences([feature], tools, valid));
  assert.throws(() => verifyFeatureReferences([], tools, valid), /不存在的功能 ID/);
  assert.throws(() => verifyFeatureReferences([feature], tools, new Map()), /不存在的文档/);
  assert.throws(
    () => verifyFeatureReferences([feature], tools, new Map([[page, '## 有标题但旧锚点已删']])),
    /文档锚点失效/,
  );
  assert.throws(() => verifyFeatureReferences([feature], new Set(), valid), /未注册的工具/);
});

test('参考页未生成和生成结果漂移分别失败', () => {
  assert.doesNotThrow(() => verifyGeneratedReference('# 功能参考\n', '# 功能参考\n'));
  assert.throws(() => verifyGeneratedReference(undefined, '# 功能参考\n'), /缺失或不同步/);
  assert.throws(() => verifyGeneratedReference('# 旧内容\n', '# 功能参考\n'), /缺失或不同步/);
});
