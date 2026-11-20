import { findFeature } from '@weq/service/feature-catalog';
import {
  describeFeatureAccess,
  type FeatureAccess,
  type FeatureAccessFacts,
} from '../../../shared/feature_access';

type Request =
  | { id: 'groups.albums'; group?: { code: string; name: string } }
  | { id: 'messages.locate'; message?: { conversation: string; seq?: string; msgId?: string } }
  | { id: 'contacts.self-profile.edit' };

/** 导航只消费当前数据源已知的选择，不从目录猜群号或消息身份。 */
export function resolveWorkspaceFeature(
  request: Request,
  source: string | null | undefined,
  currentSource: string | null | undefined,
): FeatureAccess {
  const feature = findFeature(request.id);
  if (!feature) return { status: 'unknown' };
  const context: FeatureAccessFacts['context'] = {
    account: !source ? 'missing' : source !== currentSource ? 'stale' : 'ready',
  };
  if (request.id === 'groups.albums') context.group = request.group?.code ? 'ready' : 'missing';
  if (request.id === 'messages.locate') {
    const message = request.message;
    context.message = message?.conversation && (message.seq || message.msgId) ? 'ready' : 'missing';
  }
  return describeFeatureAccess(feature, { context, entryKnown: true }).entry;
}
