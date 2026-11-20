export const FEATURE_DOMAINS = [
  'general',
  'messages',
  'contacts',
  'groups',
  'collections',
  'qzone',
  'mail',
  'channels',
  'appearance',
  'export',
  'analysis',
  'assistant',
  'settings',
  'maintenance',
] as const;

export type FeatureDomain = (typeof FEATURE_DOMAINS)[number];
export type FeatureKind = 'feature' | 'setting' | 'setting-page';

export interface FeatureDefinition {
  id: string;
  kind: FeatureKind;
  domain: FeatureDomain;
  label: string;
  aliases: readonly string[];
  summary?: string;
  settingId?: string;
  parentId?: string;
  context?: readonly ('account' | 'group' | 'contact' | 'message')[];
  /** 业务工具的已有注册名，目录本身不会执行工具。 */
  tools?: readonly string[];
  /** 产品文档仓内路径与可选锚点。 */
  docs?: readonly string[];
}

export function defineFeature(
  id: string,
  domain: FeatureDomain,
  label: string,
  aliases: readonly string[] = [],
  details: Partial<Omit<FeatureDefinition, 'id' | 'kind' | 'domain' | 'label' | 'aliases'>> = {},
): FeatureDefinition {
  return { id, kind: 'feature', domain, label, aliases, ...details };
}
