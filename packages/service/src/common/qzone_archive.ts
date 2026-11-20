import type { QzoneArchiveState, QzoneNativeDetail } from '@weqbot/protocol';

/** 与 Android 配置 106890 相同的状态集合；来源保留为默认，不冒称账号实测。 */
export const QZONE_ARCHIVE_DEFAULTS = {
  showContribute: [0, 3, 105],
  showUncontribute: [101, 102, 103, 104],
  showUnarchive: [2],
  forceFilterTag: true,
  tagStatuses: [2, 101, 102],
} as const;
export interface QzoneArchiveConfig {
  source: 'android-default' | 'qq-config';
  showContribute: readonly number[];
  showUncontribute: readonly number[];
  showUnarchive: readonly number[];
  forceFilterTag: boolean;
}
export function qzoneArchiveConfig(raw?: Record<string, unknown>): QzoneArchiveConfig {
  const list = (key: string, fallback: readonly number[]) => {
    const value = raw?.[key];
    return Array.isArray(value) &&
      value.every((item) => typeof item === 'number' && Number.isSafeInteger(item))
      ? [...new Set(value)]
      : fallback;
  };
  return {
    source: raw ? 'qq-config' : 'android-default',
    showContribute: list('show_contribute_in_share_panel', QZONE_ARCHIVE_DEFAULTS.showContribute),
    showUncontribute: list(
      'show_uncontribute_in_share_panel',
      QZONE_ARCHIVE_DEFAULTS.showUncontribute,
    ),
    showUnarchive: list('show_unarchive_in_share_panel', QZONE_ARCHIVE_DEFAULTS.showUnarchive),
    forceFilterTag:
      typeof raw?.force_filter_archive_tag === 'boolean'
        ? raw.force_filter_archive_tag
        : QZONE_ARCHIVE_DEFAULTS.forceFilterTag,
  };
}
export function projectQzoneArchive(
  detail: QzoneNativeDetail,
  self: boolean,
  config = qzoneArchiveConfig(),
) {
  const state: QzoneArchiveState = detail.archive ?? { rawStatus: null, tag: null };
  const status = state.rawStatus;
  const present = status !== null;
  return {
    ...state,
    tag:
      state.tag?.text &&
      (!config.forceFilterTag ||
        (QZONE_ARCHIVE_DEFAULTS.tagStatuses as readonly number[]).includes(status ?? -1))
        ? state.tag
        : null,
    showUpvote:
      present &&
      (config.showUnarchive.includes(status) || config.showUncontribute.includes(status)),
    canContribute:
      self &&
      present &&
      config.showContribute.includes(status) &&
      detail.archiveTarget?.commonEligible === true &&
      detail.archiveTarget.mediaKinds.every((kind) => kind >= 0),
    canUncontribute: self && present && config.showUncontribute.includes(status),
    canUnarchive: self && present && config.showUnarchive.includes(status),
    config,
  };
}
