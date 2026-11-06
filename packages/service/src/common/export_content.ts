export const EXPORT_CONTENT_KEYS = [
  'messages',
  'voice',
  'images',
  'videos',
  'files',
  'bubble',
  'font',
  'avatar',
  'widget',
  'qqFaces',
  'profiles',
] as const;
export type ExportContentKey = (typeof EXPORT_CONTENT_KEYS)[number];
export type ExportContentTier = 'none' | 'local' | 'cloud';
export const EXPORT_EXTRA_LABELS = {
  qzoneInteractions: '互动与空间属性',
  collectionProperties: '收藏属性',
  mailProperties: '邮件属性',
  generatedParameters: '模型与生成参数',
  directoryProperties: '联系人与群资料',
  resourceProperties: '资源详细信息',
} as const;
export type ExportExtraKey = keyof typeof EXPORT_EXTRA_LABELS;
export type ExportExtraOptions = Partial<Record<ExportExtraKey, boolean>>;
export const EXPORT_CONTENT_DETAILS = [
  { key: 'messageProperties', parent: 'messages', label: '属性信息' },
  { key: 'protocol', parent: 'messages', label: '协议与未解析数据' },
  { key: 'voiceProperties', parent: 'voice', label: '属性信息' },
  { key: 'voiceVariants', parent: 'voice', label: '其他已存版本' },
  { key: 'imageProperties', parent: 'images', label: '属性信息' },
  { key: 'imageVariants', parent: 'images', label: '其他已存版本' },
  { key: 'videoProperties', parent: 'videos', label: '属性信息' },
  { key: 'videoVariants', parent: 'videos', label: '其他已存版本' },
  { key: 'fileProperties', parent: 'files', label: '属性信息' },
  { key: 'fileVariants', parent: 'files', label: '其他已存版本' },
  { key: 'bubbleProperties', parent: 'bubble', label: '属性信息' },
  { key: 'fontProperties', parent: 'font', label: '属性信息' },
  { key: 'avatarProperties', parent: 'avatar', label: '属性信息' },
  { key: 'avatarVariants', parent: 'avatar', label: '其他已存版本' },
  { key: 'widgetProperties', parent: 'widget', label: '属性信息' },
  { key: 'qqFaceProperties', parent: 'qqFaces', label: '属性信息' },
  { key: 'qqFaceVariants', parent: 'qqFaces', label: '其他已存版本' },
] as const;
export type ExportContentDetailKey = (typeof EXPORT_CONTENT_DETAILS)[number]['key'];
export type ExportContentDetails = Record<ExportContentDetailKey, ExportContentTier>;
export type ExportContentPolicy = Record<
  Exclude<ExportContentKey, 'qqFaces' | 'profiles'>,
  ExportContentTier
> & {
  qqFaces: 'none' | 'local';
  profiles?: ExportContentTier;
  details?: Partial<ExportContentDetails>;
};
type ExportContentInput = Partial<Record<ExportContentKey, ExportContentTier>> & {
  details?: Partial<ExportContentDetails> & { profiles?: ExportContentTier };
};
export interface LegacyExportContent {
  exportMessages?: boolean;
  completeMessages?: boolean;
  exportMedia?: boolean;
  mediaKinds?: {
    image?: boolean;
    voice?: boolean;
    video?: boolean;
    file?: boolean;
    sysface?: boolean;
  };
  completeMedia?: boolean;
  downloadPtt?: boolean;
  downloadVideo?: boolean;
  downloadFile?: boolean;
  exportAvatar?: boolean;
  completeAvatar?: boolean;
  dress?: { bubble?: boolean; font?: boolean; widget?: boolean };
  completeDress?: boolean;
  completeDressKinds?: { bubble?: boolean; font?: boolean; widget?: boolean };
}
export function exportContentFromLegacy(value: LegacyExportContent): ExportContentPolicy {
  const media = (key: 'image' | 'voice' | 'video' | 'file', cloud?: boolean): ExportContentTier =>
    !value.exportMedia || value.mediaKinds?.[key] === false ? 'none' : cloud ? 'cloud' : 'local';
  const dress = (key: 'bubble' | 'font' | 'widget'): ExportContentTier =>
    !value.dress?.[key]
      ? 'none'
      : (value.completeDressKinds?.[key] ?? value.completeDress !== false)
        ? 'cloud'
        : 'local';
  return {
    messages: value.exportMessages === false ? 'none' : value.completeMessages ? 'cloud' : 'local',
    voice: media('voice', value.downloadPtt),
    images: media('image', value.completeMedia),
    videos: media('video', value.downloadVideo),
    files: media('file', value.downloadFile),
    bubble: dress('bubble'),
    font: dress('font'),
    widget: dress('widget'),
    avatar: !value.exportAvatar ? 'none' : value.completeAvatar === false ? 'local' : 'cloud',
    qqFaces: value.exportMedia && value.mediaKinds?.sysface !== false ? 'local' : 'none',
    profiles: value.exportMessages === false ? 'none' : 'local',
  };
}
export function normalizeExportContent(
  value: ExportContentInput | undefined,
  legacy: LegacyExportContent = {},
  guild = false,
): ExportContentPolicy {
  const result = { ...exportContentFromLegacy(legacy), ...value };
  result.profiles =
    value?.profiles ?? value?.details?.profiles ?? (result.messages === 'none' ? 'none' : 'local');
  for (const key of EXPORT_CONTENT_KEYS)
    if (!['none', 'local', 'cloud'].includes(result[key] ?? ''))
      throw new Error('导出内容档位无效。');
  if (result.qqFaces === 'cloud') result.qqFaces = 'local';
  if (result.profiles === 'cloud') result.profiles = 'local';
  if (guild && result.messages === 'cloud') result.messages = 'local';
  const details: Partial<ExportContentDetails> = {};
  for (const item of EXPORT_CONTENT_DETAILS) {
    const tier = value?.details?.[item.key] ?? (result[item.parent] === 'none' ? 'none' : 'local');
    if (!['none', 'local', 'cloud'].includes(tier)) throw new Error('导出明细档位无效。');
    // 明细保存本轮已取得的数据，不为属性、协议或缓存变体另发网络请求。
    details[item.key] = tier === 'cloud' ? 'local' : tier;
  }
  result.details = details;
  return { ...result, qqFaces: result.qqFaces === 'none' ? 'none' : 'local' };
}
export function exportContentFlags(value: ExportContentPolicy) {
  const selected = (key: ExportContentKey) => value[key] !== 'none';
  const cloud = (key: ExportContentKey) => value[key] === 'cloud';
  return {
    exportMessages: selected('messages'),
    completeMessages: cloud('messages'),
    exportMedia: ['voice', 'images', 'videos', 'files', 'qqFaces'].some((key) =>
      selected(key as ExportContentKey),
    ),
    mediaKinds: {
      image: selected('images'),
      voice: selected('voice'),
      video: selected('videos'),
      file: selected('files'),
      sysface: selected('qqFaces'),
    },
    completeMedia: cloud('images'),
    downloadPtt: cloud('voice'),
    downloadVideo: cloud('videos'),
    downloadFile: cloud('files'),
    exportAvatar: selected('avatar'),
    completeAvatar: cloud('avatar'),
    dress: { bubble: selected('bubble'), font: selected('font'), widget: selected('widget') },
    completeDress: cloud('bubble') || cloud('font') || cloud('widget'),
    completeDressKinds: { bubble: cloud('bubble'), font: cloud('font'), widget: cloud('widget') },
  };
}
export function hasExportContent(value: ExportContentPolicy): boolean {
  const policy = normalizeExportContent(value);
  return (
    EXPORT_CONTENT_KEYS.some((key) => policy[key] !== 'none') ||
    Object.values(policy.details ?? {}).some((tier) => tier !== 'none')
  );
}

export function hasExportResources(value: ExportContentPolicy): boolean {
  const policy = normalizeExportContent(value);
  return (
    EXPORT_CONTENT_KEYS.some(
      (key) => key !== 'messages' && key !== 'profiles' && policy[key] !== 'none',
    ) ||
    EXPORT_CONTENT_DETAILS.some(
      (item) => item.key.endsWith('Variants') && policy.details?.[item.key] === 'local',
    )
  );
}

export function requiresStructuredExport(value: ExportContentPolicy): boolean {
  const policy = normalizeExportContent(value);
  return (
    policy.profiles !== 'none' ||
    EXPORT_CONTENT_DETAILS.some(
      (item) => !item.key.endsWith('Variants') && policy.details?.[item.key] === 'local',
    )
  );
}

export function addedStructuredContent(
  before: ExportContentPolicy,
  after: ExportContentPolicy,
): boolean {
  const old = normalizeExportContent(before),
    next = normalizeExportContent(after);
  return (
    (old.profiles === 'none' && next.profiles !== 'none') ||
    EXPORT_CONTENT_DETAILS.some(
      (item) =>
        !item.key.endsWith('Variants') &&
        old.details?.[item.key] !== 'local' &&
        next.details?.[item.key] === 'local',
    )
  );
}

export function withoutStructuredContent(value: ExportContentPolicy): ExportContentPolicy {
  const policy = normalizeExportContent(value);
  return normalizeExportContent({
    ...policy,
    profiles: 'none',
    details: Object.fromEntries(
      EXPORT_CONTENT_DETAILS.map((item) => [
        item.key,
        item.key.endsWith('Variants') ? (policy.details?.[item.key] ?? 'none') : 'none',
      ]),
    ),
  });
}
export function selectAllExportContent(
  tier: ExportContentTier,
  guild = false,
): ExportContentPolicy {
  return normalizeExportContent(
    Object.fromEntries(EXPORT_CONTENT_KEYS.map((key) => [key, tier])) as Record<
      ExportContentKey,
      ExportContentTier
    >,
    {},
    guild,
  );
}
export function selectExportContentGroup(
  value: ExportContentPolicy,
  key: ExportContentKey,
  tier: ExportContentTier,
  guild = false,
): ExportContentPolicy {
  const details = { ...value.details };
  for (const item of EXPORT_CONTENT_DETAILS)
    if (item.parent === key) details[item.key] = tier === 'none' ? 'none' : 'local';
  return normalizeExportContent({ ...value, [key]: tier, details }, {}, guild);
}

export function selectExportContentDetails(
  value: ExportContentPolicy,
  tier: 'none' | 'local',
): ExportContentPolicy {
  return normalizeExportContent({
    ...value,
    details: Object.fromEntries(EXPORT_CONTENT_DETAILS.map((item) => [item.key, tier])),
  });
}

export function exportContentDetailsTier(value: ExportContentPolicy): 'none' | 'local' | null {
  const policy = normalizeExportContent(value);
  return (
    (['none', 'local'] as const).find((tier) =>
      EXPORT_CONTENT_DETAILS.every((item) => policy.details?.[item.key] === tier),
    ) ?? null
  );
}
export function exportContentAllTier(
  value: ExportContentPolicy,
  guild = false,
): ExportContentTier | null {
  return (
    (['none', 'local', 'cloud'] as const).find((tier) => {
      const expected = selectAllExportContent(tier, guild);
      return EXPORT_CONTENT_KEYS.every((key) => value[key] === expected[key]);
    }) ?? null
  );
}
