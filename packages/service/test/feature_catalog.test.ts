import { describe, expect, it } from 'vitest';
import { findFeature, listFeatures, settingFeatureId } from '../src/common/feature_catalog';
import { listSettings } from '../src/common/settings_catalog';

describe('功能目录', () => {
  it('所有身份唯一，父级引用存在且不成环', () => {
    const features = listFeatures();
    expect(new Set(features.map(({ id }) => id)).size).toBe(features.length);
    for (const feature of features) {
      expect(findFeature(feature.id)).toBe(feature);
      const visited = new Set([feature.id]);
      let parentId = feature.parentId;
      while (parentId) {
        expect(visited.has(parentId), `循环关联：${feature.id} → ${parentId}`).toBe(false);
        const parent = findFeature(parentId);
        expect(parent, `功能父级不存在：${parentId}`).toBeDefined();
        visited.add(parentId);
        parentId = parent?.parentId;
      }
    }
    expect(findFeature('export.unknown-fixture')).toBeUndefined();
  });

  it('设置逐项沿用公开注册表的稳定身份、名称和别名', () => {
    const settings = listSettings();
    expect(listFeatures({ kind: 'setting' })).toHaveLength(settings.length);
    for (const setting of settings) {
      expect(findFeature(settingFeatureId(setting.id))).toMatchObject({
        kind: 'setting',
        settingId: setting.id,
        label: setting.label,
        aliases: setting.aliases,
        parentId: `settings.page.${setting.page}`,
      });
    }
  });

  it('可独立查询导出与有对象上下文的同名功能，以及只有工具入口的诊断', () => {
    expect(listFeatures({ query: '群相册', domain: 'export' })[0]?.id).toBe('export.group-albums');
    expect(listFeatures({ query: '群相册', domain: 'groups' })[0]).toMatchObject({
      id: 'groups.albums',
      context: ['account', 'group'],
      tools: ['get_group_albums'],
    });
    expect(findFeature('maintenance.message-performance')).toMatchObject({
      kind: 'feature',
      tools: ['get_message_performance'],
    });
    expect(listFeatures({ query: '完整消息导出', kind: 'feature' })[0]?.id).toBe(
      'export.chat-history',
    );
  });
});
