import {
  ContactRound,
  File,
  FileText,
  Images,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  Settings2,
  Store,
  UserRound,
  UsersRound,
  Zap,
} from 'lucide-react';
import { FEATURE_ICONS } from '../../lib/featureIcons.shared';
import type { FeatureIcon } from '../../lib/featureIcons';
import type { SearchCategory } from './types';
import type { SearchSource } from '@weq/service/search-policy';

// 筛选项与结果占位共用语义，不再分别维护两套图标选择分支。
export const SEARCH_CATEGORY_ICONS = {
  contact: UserRound,
  group: UsersRound,
  conversation: FEATURE_ICONS.messages,
  friend: UserRound,
  groupMember: ContactRound,
  chatRecord: MessagesSquare,
  file: File,
  qzone: FEATURE_ICONS.qzone,
  collection: FEATURE_ICONS.collections,
  qzonePost: FileText,
  qzoneAlbum: Images,
  otherQzonePost: FileText,
  otherQzoneAlbum: Images,
  groupAlbum: FEATURE_ICONS.groupAlbum,
  groupFile: FEATURE_ICONS.groupFile,
  mailMessage: FEATURE_ICONS.mail,
  guildMessage: FEATURE_ICONS.guildDirect,
  groupBulletin: Megaphone,
  groupEssence: FEATURE_ICONS.groupEssence,
  flashFile: Zap,
  qzoneComment: MessageSquare,
  otherQzoneComment: MessageSquare,
  qzonePublicComment: MessageSquare,
  cloneMessage: FEATURE_ICONS.clone,
  assistantMessage: FEATURE_ICONS.assistant,
  marketEmoji: Store,
} satisfies Record<SearchCategory, FeatureIcon>;

export const SEARCH_SOURCE_ICONS = {
  qq: MessagesSquare,
  clone: FEATURE_ICONS.clone,
  assistant: FEATURE_ICONS.assistant,
  app: Settings2,
} satisfies Record<SearchSource, FeatureIcon>;
