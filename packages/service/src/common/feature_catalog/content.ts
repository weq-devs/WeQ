import { defineFeature, type FeatureDefinition } from './model';

function qzoneSection(id: string, label: string, summary: string) {
  return defineFeature(`qzone.${id}`, 'qzone', label, [], {
    parentId: 'qzone.timeline',
    context: ['account'],
    navigation: 'search',
    summary,
  });
}

export const QZONE_SECTION_FEATURES = {
  feeds: qzoneSection('friend-feed', '好友动态', '从已有空间栏目查看好友动态。'),
  posts: qzoneSection('self-space', '我的空间', '查看当前 QQ 账号的空间。'),
  related: qzoneSection('related', '与我相关', '浏览与当前账号相关的空间互动。'),
  public: qzoneSection('public-feed', '空友爱看', '打开已有的公开推荐动态栏目。'),
};
export type QzoneFeatureSection = keyof typeof QZONE_SECTION_FEATURES;

export const OWN_ALBUM_FEATURE = defineFeature(
  'qzone.self-albums',
  'qzone',
  '我的空间相册',
  ['浏览我的相册'],
  {
    parentId: 'qzone.timeline',
    context: ['account'],
    navigation: 'search',
    summary: '打开当前账号的相册浏览窗口。',
    docs: ['guide/album-qzone.md#feature-qzone.self-albums'],
  },
);

type ContentDomain = 'qzone' | 'mail' | 'collections' | 'appearance';
function content(
  id: string,
  domain: ContentDomain,
  label: string,
  summary: string,
  details: Partial<Pick<FeatureDefinition, 'context' | 'docs'>> = {},
) {
  return defineFeature(`${domain}.${id}`, domain, label, [], {
    context: ['account', 'content'],
    navigation: 'context',
    summary,
    ...details,
  });
}

export const CONTENT_FEATURES = [
  content('post.compose', 'qzone', '写说说', '打开已有的说说编辑器，发布前可设置可见范围。', {
    context: ['account'],
  }),
  content(
    'post.interactions',
    'qzone',
    '说说互动',
    '选定说说后查看已有点赞与评论，或使用适用操作。',
  ),
  content('message.read', 'mail', '查看邮件', '从邮箱列表选择邮件以读正文和附件。', {
    docs: ['guide/qqmail.md#feature-mail.message.read'],
  }),
  content('compose', 'mail', '写信与草稿', '在邮箱使用已有编辑器，保留草稿保存与退出确认。', {
    context: ['account'],
    docs: ['guide/qqmail.md#feature-mail.compose'],
  }),
  content(
    'attachment.save',
    'mail',
    '保存邮件附件',
    '在已打开的邮件中按当前端的保存流程另存附件。',
    {
      docs: ['guide/qqmail.md#feature-mail.attachment.save'],
    },
  ),
  content('search', 'collections', '搜索收藏', '在现有收藏页按关键词与材料类型查找条目。', {
    context: ['account'],
    docs: ['guide/collection.md#feature-collections.search'],
  }),
  content('detail', 'collections', '打开收藏内容', '根据收藏类型打开正文、图片、链接或其他内容。'),
  content('emoji.favorites', 'appearance', '聊天收藏表情', '从聊天的表情面板将收藏表情加入草稿。', {
    context: ['account', 'conversation'],
    docs: ['guide/emoji-resources.md#feature-appearance.emoji.favorites'],
  }),
] as const;
