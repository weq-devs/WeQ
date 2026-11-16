import {
  Activity,
  ArchiveRestore,
  Bell,
  BookOpen,
  Boxes,
  BrainCircuit,
  Bug,
  ChartNoAxesCombined,
  ChartPie,
  ContactRound,
  Database,
  EyeOff,
  FolderCog,
  Globe,
  HardDrive,
  HelpCircle,
  Info,
  KeyRound,
  MessageSquareReply,
  MessagesSquare,
  MonitorSmartphone,
  Newspaper,
  Package,
  PackageOpen,
  Palette,
  PhoneCall,
  Plug,
  PlugZap,
  Power,
  Radio,
  RadioTower,
  ScanSearch,
  ScanText,
  Send,
  Server,
  Settings2,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import { FEATURE_ICONS, type FeatureIcon } from '../../lib/featureIcons';
import type { SettingsPageId } from './navigation';

export const SETTINGS_PAGE_ICONS = {
  'contact-card': ContactRound,
  backup: ArchiveRestore,
  global: Bell,
  version: Package,
  appearance: Palette,
  privacy: EyeOff,
  account: PlugZap,
  accounts: UsersRound,
  'call-recording': PhoneCall,
  qzone: FEATURE_ICONS.qzone,
  mail: FEATURE_ICONS.mail,
  'database-management': Database,
  'qq-storage': FolderCog,
  'enhancement-packs': PackageOpen,
  'resource-loading': Globe,
  logs: Activity,
  diagnostics: ScanSearch,
  'model-usage': ChartNoAxesCombined,
  recognition: ScanText,
  agentlab: Boxes,
  'interaction-profile': ChartPie,
  'reply-suggestions': MessageSquareReply,
  'intent-sense': BrainCircuit,
  mcp: Plug,
  onebot: RadioTower,
  remote: MonitorSmartphone,
  assistant: Newspaper,
  sse: Radio,
  faq: HelpCircle,
  feedback: Bug,
  'chat-messages': MessagesSquare,
  'message-display': BookOpen,
  'chat-interaction': Send,
  startup: Power,
  'weq-storage': HardDrive,
  credentials: KeyRound,
} satisfies Record<SettingsPageId, FeatureIcon>;

export const SETTINGS_GROUP_ICONS: Record<string, FeatureIcon> = {
  general: Settings2,
  basic: MessagesSquare,
  models: Sparkles,
  data: Database,
  services: Server,
  help: Info,
};

export function SettingsGroupIcon({ group }: { group: string }) {
  const Icon = SETTINGS_GROUP_ICONS[group] ?? Settings2;
  return <Icon size={16} strokeWidth={1.8} aria-hidden />;
}

export function SettingsPageIcon({ page }: { page: SettingsPageId }) {
  const Icon = SETTINGS_PAGE_ICONS[page];
  return <Icon size={16} strokeWidth={1.8} aria-hidden />;
}
