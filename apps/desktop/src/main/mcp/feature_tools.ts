import {
  FEATURE_CATALOG_VERSION,
  FEATURE_DOMAINS,
  findFeature,
  listFeatures,
  type FeatureDefinition,
} from '@weq/service/feature-catalog';
import {
  describeFeatureAccess,
  FEATURE_CLIENTS,
  featureUnsupported,
} from '../../shared/feature_access';
import { z } from 'zod';
import { getAppContext } from '../context/app_context';
import { toolExecutionOptions } from './account_scope';
import { canLinkToFeature, featureLink } from '../../shared/feature_links';

const clientInput = z.enum(FEATURE_CLIENTS).optional().describe('仅在知道目标客户端时传入');
export const listFeaturesInput = z.object({
  domain: z.enum(FEATURE_DOMAINS).optional(),
  kind: z.enum(['feature', 'setting', 'setting-page']).optional(),
  query: z.string().trim().max(120).optional(),
  client: clientInput,
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
export const getFeatureInput = z.object({
  id: z.string().trim().min(1).max(120),
  client: clientInput,
});

export async function listFeatureDefinitions({
  client,
  offset,
  limit,
  ...filters
}: z.infer<typeof listFeaturesInput>) {
  const features = listFeatures(filters).filter((feature) => !featureUnsupported(feature, client));
  const next = offset + limit;
  return {
    version: FEATURE_CATALOG_VERSION,
    entries: features
      .slice(offset, next)
      .map(({ id, label, kind, domain }) => ({ id, label, kind, domain })),
    nextOffset: next < features.length ? next : null,
  };
}

function hasNavigation(feature: FeatureDefinition): boolean {
  return canLinkToFeature(feature) || feature.navigation === 'context';
}

export async function getFeatureDefinition({ id, client }: z.infer<typeof getFeatureInput>) {
  const feature = findFeature(id);
  if (!feature) return { found: false, id, version: FEATURE_CATALOG_VERSION };
  const ctx = getAppContext();
  const record =
    feature.operation === 'album-list' || feature.operation === 'profile-write'
      ? ctx.services?.accountConfig?.getRecord()
      : undefined;
  const model =
    feature.operation === 'default-chat-model'
      ? ctx.bootstrap?.agentLabConfig?.getDefaultModelStatus()
      : undefined;
  const { visibleToolNames: visible, featureLinks } = toolExecutionOptions();
  const entryKnown = hasNavigation(feature);
  const access = describeFeatureAccess(feature, {
    client,
    entryKnown: Boolean(client && entryKnown),
    context: {
      account: ctx.account && ctx.services ? 'ready' : 'missing',
      group: 'missing',
      contact: 'missing',
      conversation: 'missing',
      content: 'missing',
      message: 'missing',
    },
    qqOnline: record ? Boolean(record.qqOnline && record.qqPid) : undefined,
    profileWriteReady: record && !record.qqOnline ? false : undefined,
    defaultChatModelReady: model?.available,
  });
  const {
    id: stableId,
    label,
    kind,
    domain,
    aliases,
    summary,
    docs,
    context,
    settingId,
    settingsPage,
  } = feature;
  return {
    found: true,
    version: FEATURE_CATALOG_VERSION,
    feature: {
      id: stableId,
      label,
      kind,
      domain,
      aliases,
      summary,
      docs,
      context,
      settingId,
      settingsPage,
    },
    navigation: entryKnown
      ? {
          featureId: stableId,
          needs: context ?? [],
          url:
            featureLinks && canLinkToFeature(feature) && access.entry.status !== 'unsupported'
              ? featureLink(stableId)
              : undefined,
        }
      : null,
    ...access,
    tools: (feature.tools ?? []).map((name) => ({
      name,
      exposed: visible ? visible.includes(name) : null,
    })),
  };
}
