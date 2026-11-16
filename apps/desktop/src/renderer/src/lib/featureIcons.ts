import { createElement, type ComponentType } from 'react';
import {
  Bookmark,
  BookOpenCheck,
  Bot,
  BotMessageSquare,
  CalendarClock,
  Check,
  ClipboardList,
  CloudDownload,
  Code2,
  Database,
  DatabaseZap,
  FileKey2,
  FileOutput,
  Fingerprint,
  FolderOpen,
  Gem,
  Image,
  Images,
  Heart,
  Award,
  KeyRound,
  KeySquare,
  Mail,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  PhoneCall,
  Radio,
  Smile,
  Sparkles,
  Star,
  Palette,
  Store,
  Type,
  Trash2,
  UserPlus,
  UsersRound,
  Wallet,
  ChartPie,
} from 'lucide-react';
import { SiQzone } from 'react-icons/si';
import type { DressKind } from '../components/DressUpDialog';
import type { ExportMode } from '../views/export/types';
import type { MaintenanceTool } from '../components/settings/DataMaintenanceSection';

type FeatureIconProps = {
  size?: number;
  strokeWidth?: number;
  'aria-hidden'?: boolean;
};
export type FeatureIcon = ComponentType<FeatureIconProps>;

function QzoneIcon(props: FeatureIconProps) {
  // 品牌标识是填充轮廓，不能让线稿入口传入的描边堵住内部留白。
  return createElement(SiQzone, { ...props, stroke: 'none', strokeWidth: 0, focusable: false });
}

// 同一功能跨导航、搜索、设置和内容工具复用图形；尺寸由所在层级决定。
export const FEATURE_ICONS = {
  messages: MessageCircle,
  contacts: UsersRound,
  collections: Bookmark,
  qzone: QzoneIcon,
  mail: Mail,
  guildDirect: MessagesSquare,
  annual: BookOpenCheck,
  clone: Bot,
  cloneGroup: BotMessageSquare,
  assistant: Sparkles,
  export: FileOutput,
  backfill: CloudDownload,
  friendNotice: UserPlus,
  groupNotice: ClipboardList,
  groupEssence: Star,
  groupAlbum: Images,
  groupFile: FolderOpen,
  dressup: Palette,
  specialCare: Heart,
  groupTitle: Award,
} satisfies Record<string, FeatureIcon>;

export const EXPORT_MODE_ICONS = {
  full: FEATURE_ICONS.messages,
  guild: FEATURE_ICONS.guildDirect,
  generated: BotMessageSquare,
  qzone: FEATURE_ICONS.qzone,
  contacts: FEATURE_ICONS.contacts,
  collection: FEATURE_ICONS.collections,
  mail: FEATURE_ICONS.mail,
  emojipack: Smile,
  album: FEATURE_ICONS.groupAlbum,
  groupfile: FEATURE_ICONS.groupFile,
  database: Database,
  scheduled: CalendarClock,
  'persona-bot': FEATURE_ICONS.clone,
} satisfies Record<ExportMode, FeatureIcon>;

export const DRESS_KIND_ICONS = {
  usage: Check,
  bubble: MessageSquare,
  font: Type,
  widget: Gem,
  callbg: PhoneCall,
  background: Image,
  emoji: Store,
  redpack: Wallet,
} satisfies Record<DressKind, FeatureIcon>;

export const MAINTENANCE_TOOL_ICONS = {
  cache: FolderOpen,
  database: Database,
  storage: ChartPie,
  cleanup: Trash2,
  'db-repair': DatabaseZap,
  'db-decrypt': FileKey2,
  'key-scan': KeyRound,
  'other-device-key': KeySquare,
  'login-accounts': Fingerprint,
  capture: Radio,
  reverse: Code2,
} satisfies Record<MaintenanceTool, FeatureIcon>;
