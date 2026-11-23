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
  AnalysisReportsTool,
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
  'analysis-reports': AnalysisReportsTool,
  backfill: RoamingBackfillPanel,
  agentlab: AgentLabView,
  annual: AnnualReportView,
};
// 打开更多后只预热常用子页；其余按导航意图加载。
export const mobileMorePageLoaders = [
  QzoneWorkspace.preload,
  SettingsDialog.preload,
  CollectionDialog.preload,
];
export function preloadWorkspace(name: string): void {
  if (Object.hasOwn(navigation, name))
    void navigation[name as keyof typeof navigation].preload().catch(() => {});
}
