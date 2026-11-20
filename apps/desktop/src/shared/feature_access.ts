import type {
  FeatureContext,
  FeatureDefinition,
  FeatureOperation,
} from '@weq/service/feature-catalog';
import { findSettingDefinition, resolveSettingsTarget } from '@weq/service/settings-catalog';
import { remoteSettingAvailable } from './remote_capabilities';

export const FEATURE_CLIENTS = ['desktop', 'web', 'remote'] as const;
export type FeatureClient = (typeof FEATURE_CLIENTS)[number];
type Observation = 'ready' | 'missing' | 'stale';
export type FeatureAccess =
  | { status: 'available' }
  | { status: 'unsupported' }
  | { status: 'unknown' }
  | { status: 'needs-context'; missing: readonly FeatureContext[] }
  | { status: 'unavailable'; reason: 'stale-context' | FeatureOperation };

export interface FeatureAccessFacts {
  client?: FeatureClient;
  context?: Partial<Record<FeatureContext, Observation>>;
  entryKnown?: boolean;
  qqOnline?: boolean;
  profileWriteReady?: boolean;
  defaultChatModelReady?: boolean;
  imageCached?: boolean;
}

/** 设置导航、搜索和外部说明使用原设置注册表及 Remote 能力表。 */
export function settingFeatureAllowed(
  target: Parameters<typeof resolveSettingsTarget>[0],
  client: FeatureClient,
): boolean {
  const { section, settingId, item } = resolveSettingsTarget(target);
  if (client !== 'desktop' && settingId && findSettingDefinition(settingId)?.desktopOnly)
    return false;
  return client !== 'remote' || remoteSettingAvailable(section, settingId, item);
}

export function featureUnsupported(feature: FeatureDefinition, client?: FeatureClient): boolean {
  return Boolean(
    client &&
      feature.settingsPage &&
      !settingFeatureAllowed(
        {
          section: feature.settingsPage,
          settingId: feature.settingId,
          item: feature.settingId ? feature.label : undefined,
        },
        client,
      ),
  );
}

export function describeFeatureAccess(
  feature: FeatureDefinition,
  facts: FeatureAccessFacts,
): { entry: FeatureAccess; operation: FeatureAccess } {
  if (featureUnsupported(feature, facts.client))
    return { entry: { status: 'unsupported' }, operation: { status: 'unsupported' } };
  const context = feature.context ?? [];
  if (context.some((key) => facts.context?.[key] === 'stale')) {
    const stale = { status: 'unavailable', reason: 'stale-context' } as const;
    return { entry: stale, operation: stale };
  }
  const missing = context.filter((key) => facts.context?.[key] === 'missing');
  if (missing.length) {
    const required = { status: 'needs-context', missing } as const;
    return { entry: required, operation: required };
  }
  if (context.some((key) => facts.context?.[key] !== 'ready'))
    return { entry: { status: 'unknown' }, operation: { status: 'unknown' } };
  const operation = feature.operation;
  const ready =
    operation === 'album-list'
      ? facts.qqOnline // Web 登录兜底不要求已读内存或 ClientKey。
      : operation === 'profile-write'
        ? facts.profileWriteReady
        : operation === 'default-chat-model'
          ? facts.defaultChatModelReady
          : operation === 'chat-image' && facts.imageCached
            ? true
            : undefined; // 还可能有 CDN、外部 rkey 等来源。
  return {
    entry: { status: facts.entryKnown ? 'available' : 'unknown' },
    operation:
      ready === true
        ? { status: 'available' }
        : ready === false && operation
          ? { status: 'unavailable', reason: operation }
          : { status: 'unknown' },
  };
}
