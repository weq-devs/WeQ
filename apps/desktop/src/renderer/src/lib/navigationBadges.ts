export type NavigationBadge = {
  kind: 'unread' | 'notice' | 'running';
  count: number;
  description: string;
};

const badgePriority = { unread: 3, notice: 2, running: 1 };

export function navigationBadge(
  kind: NavigationBadge['kind'],
  count: number,
  description: string,
): NavigationBadge | undefined {
  return Number.isFinite(count) && count > 0 ? { kind, count, description } : undefined;
}

export function summarizeNavigationBadges(entries: Iterable<NavigationBadge | undefined>) {
  let badge: NavigationBadge | undefined;
  let description = '';
  for (const entry of entries) {
    if (!entry) continue;
    if (!badge || badgePriority[entry.kind] > badgePriority[badge.kind]) badge = entry;
    description += `，${entry.description}`;
  }
  return { badge, description };
}
