import { describe, expect, it } from 'vitest';
import {
  exportContentAllTier,
  exportContentFlags,
  hasExportContent,
  normalizeExportContent,
  selectAllExportContent,
  selectExportContentGroup,
  selectExportContentDetails,
  exportContentDetailsTier,
  hasExportResources,
  requiresStructuredExport,
  withoutStructuredContent,
} from '../src/common/export_content';

describe('导出内容独立明细', () => {
  it('资源与已有版本可独立保存，拒绝 JSON 时只移除依赖它的属性和资料', () => {
    const policy = {
      ...selectAllExportContent('none'),
      images: 'local' as const,
      profiles: 'local' as const,
      details: { imageProperties: 'local' as const, imageVariants: 'local' as const },
    };
    expect(requiresStructuredExport(policy)).toBe(true);
    expect(hasExportResources(policy)).toBe(true);
    const resources = withoutStructuredContent(policy);
    expect(resources.images).toBe('local');
    expect(resources.details?.imageVariants).toBe('local');
    expect(resources.details?.imageProperties).toBe('none');
    expect(resources.profiles).toBe('none');
    expect(requiresStructuredExport(resources)).toBe(false);
  });
  it('关闭附加数据不清除全部的一级项目选择状态', () => {
    expect(
      exportContentAllTier(selectExportContentDetails(selectAllExportContent('local'), 'none')),
    ).toBe('local');
    expect(
      exportContentAllTier(selectExportContentDetails(selectAllExportContent('cloud'), 'none')),
    ).toBe('cloud');
  });
  it('附加数据总控只改变所有附加明细，不改变正文、资源或独立资料项目', () => {
    const policy = selectAllExportContent('none');
    const selected = selectExportContentDetails(policy, 'local');
    expect(exportContentDetailsTier(selected)).toBe('local');
    expect(selected.messages).toBe('none');
    expect(selected.images).toBe('none');
    expect(selected.profiles).toBe('none');
    expect(hasExportContent(selected)).toBe(true);
    expect(exportContentDetailsTier(selectExportContentDetails(selected, 'none'))).toBe('none');
  });
  it('旧消息资料明细迁入独立资料项，明确的新资料选择优先', () => {
    const { profiles: _profiles, ...legacy } = selectAllExportContent('none');
    expect(normalizeExportContent({ ...legacy, details: { profiles: 'local' } }).profiles).toBe(
      'local',
    );
    expect(
      normalizeExportContent({ ...legacy, profiles: 'none', details: { profiles: 'local' } })
        .profiles,
    ).toBe('none');
  });
  it('所有父项关闭后仍可仅导出一项明细', () => {
    const policy = normalizeExportContent({
      ...selectAllExportContent('none'),
      details: { imageProperties: 'local' },
    });
    expect(policy.images).toBe('none');
    expect(policy.details?.imageProperties).toBe('local');
    expect(hasExportContent(policy)).toBe(true);
    expect(exportContentFlags(policy).exportMedia).toBe(false);
    expect(exportContentAllTier(policy)).toBe('none');
  });
  it('明细和 QQ 表情不产生云端补全意图', () => {
    const policy = normalizeExportContent({
      ...selectAllExportContent('cloud'),
      details: { imageVariants: 'cloud' },
    });
    expect(policy.qqFaces).toBe('local');
    expect(policy.details?.imageVariants).toBe('local');
    expect(selectAllExportContent('cloud', true).messages).toBe('local');
  });
  it('切换父项后仍能独立重新开启明细，全部关闭恢复空选', () => {
    const policy = selectExportContentGroup(selectAllExportContent('local'), 'images', 'none');
    expect(policy.details?.imageVariants).toBe('none');
    expect(hasExportContent(selectAllExportContent('none'))).toBe(false);
  });
});
