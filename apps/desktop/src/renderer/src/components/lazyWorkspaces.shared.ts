import {
  QzoneWorkspace,
  SettingsDialog,
  CollectionDialog,
  DataMaintenanceDialog,
  ChannelView,
  GuildDirectDialog,
  DressUpDialog,
  ExportTool,
  ExportViewer,
  AnalysisTool,
  RoamingBackfillPanel,
  AgentLabView,
  AnnualReportView,
} from './lazyWorkspaces';

const navigation = {
  settings: SettingsDialog,
  maintenance: DataMaintenanceDialog,
  collections: CollectionDialog,
  qzone: QzoneWorkspace,
  channel: ChannelView,
  'guild-direct': GuildDirectDialog,
  dressup: DressUpDialog,
  export: ExportTool,
  viewer: ExportViewer,
  analysis: AnalysisTool,
  backfill: RoamingBackfillPanel,
  agentlab: AgentLabView,
  annual: AnnualReportView,
};
// 首次进入只备好相邻的空间页；重工具由导航意图触发，不遍历整张功能表。
export const mobilePageLoaders = [QzoneWorkspace.preload];
export const mobileMorePageLoaders = [SettingsDialog.preload, CollectionDialog.preload];
export function preloadWorkspace(name: string): void {
  if (Object.hasOwn(navigation, name))
    void navigation[name as keyof typeof navigation].preload().catch(() => {});
}
