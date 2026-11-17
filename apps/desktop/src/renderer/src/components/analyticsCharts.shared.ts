import * as timeFormat from '@weq/time';

/**
 * Shared analytics visualisations used by both the group (GroupAnalyticsDialog)
 * and private-chat (BuddyAnalyticsDialog) analysis pages:
 *   - HourlyBarChart      — 24-hour activity bars
 *   - ContributionHeatmap — GitHub-style daily heatmap (绿墙), full trailing year
 *   - WordCloud           — canvas-measured spiral layout, Chinese-friendly
 */

export const ACCENT = 'var(--weq-accent-effective)';

/**
 * Accent-following categorical palette. Every entry is a `color-mix` dominated
 * by the picked accent, so a multi-category chart reads as one cohesive theme
 * colour instead of a clashing rainbow — the categories stay distinguishable
 * via a small hue nudge, but the whole thing follows 设置里的主题色. Mirrors the
 * WordCloud approach below.
 */
export const ACCENT_SERIES = [
  'var(--weq-accent-effective)',
  'color-mix(in srgb, var(--weq-accent-effective) 80%, #8b5cf6)',
  'color-mix(in srgb, var(--weq-accent-effective) 72%, #06b6d4)',
  'color-mix(in srgb, var(--weq-accent-effective) 74%, #22c55e)',
  'color-mix(in srgb, var(--weq-accent-effective) 76%, #f59e0b)',
  'color-mix(in srgb, var(--weq-accent-effective) 72%, #ec4899)',
  'color-mix(in srgb, var(--weq-accent-effective) 64%, #f43f5e)',
  'color-mix(in srgb, var(--weq-fg-primary) 42%, var(--weq-accent-effective))',
] as const;

/** A soft, theme-neutral colour for a "misc/其它" slice. */
export const ACCENT_MUTED = 'color-mix(in srgb, var(--weq-fg-primary) 26%, transparent)';

export function formatNumber(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatDate(ts: number | null): string {
  return ts && ts > 0 ? timeFormat.formatUnixTime(ts) || '-' : '-';
}

/** 秒数转换为带数字间距的中文时长。 */
export function formatDuration(sec: number): string {
  return timeFormat.formatDuration(sec, 'approximate') || '-';
}
