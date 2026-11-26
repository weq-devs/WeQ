import type { FeatureDefinition } from '@weq/service/feature-catalog';

const FEATURE_LOCATION = 'https://weq-feature.invalid/open/';
export const OPEN_FEATURE_EVENT = 'weq:open-feature';

/** 可从目录直接打开的现有入口；有群或消息参数的入口继续由工作区解析对象。 */
export function canLinkToFeature(feature: FeatureDefinition): boolean {
  return Boolean(feature.settingsPage) || feature.navigation === 'search';
}

export function featureLink(id: string): string {
  return FEATURE_LOCATION + encodeURIComponent(id);
}

export function featureIdFromLink(href: string | undefined): string | undefined {
  if (!href?.startsWith(FEATURE_LOCATION)) return undefined;
  const suffix = href.slice(FEATURE_LOCATION.length);
  try {
    const id = decodeURIComponent(suffix);
    if (/^[a-z0-9][a-z0-9.:-]*$/.test(id) && encodeURIComponent(id) === suffix) return id;
  } catch {
    // 无效或尚在流式生成中的链接。
  }
}
