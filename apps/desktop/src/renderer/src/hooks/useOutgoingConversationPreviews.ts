import { useState } from 'react';
import {
  updateOutgoingConversationPreviews,
  type OutgoingPreviewRecord,
  type RecentOutgoingSummary,
  type OutgoingConversationPreviews,
} from '../lib/outgoingConversationPreview';

export function useOutgoingConversationPreviews(
  scope: string,
  groups: readonly (readonly OutgoingPreviewRecord[])[],
  recent: readonly RecentOutgoingSummary[],
): OutgoingConversationPreviews {
  const [snapshot, setSnapshot] = useState(() => ({
    scope,
    groups,
    recent,
    previews: updateOutgoingConversationPreviews(new Map(), groups.flat(), recent),
  }));
  if (
    snapshot.scope !== scope ||
    snapshot.recent !== recent ||
    snapshot.groups.length !== groups.length ||
    snapshot.groups.some((group, index) => group !== groups[index])
  ) {
    // 与占位一起在渲染阶段切换来源，避免旧账号的成功摘要被新来源继承。
    const previews =
      snapshot.scope === scope
        ? updateOutgoingConversationPreviews(snapshot.previews, groups.flat(), recent)
        : new Map();
    setSnapshot({ scope, groups, recent, previews });
    return previews;
  }
  return snapshot.previews;
}
