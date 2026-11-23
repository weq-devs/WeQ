import { createElement, type ComponentProps } from 'react';
import { lazyPanel, lazyRetainedPanel } from '../lib/lazyPanel';
import { PanelLoading } from './LoadingIndicator';

const toolLoading = () => createElement<{ startup?: boolean }>(PanelLoading, { startup: false });

export const SettingsDialog = lazyPanel<
  ComponentProps<typeof import('./SettingsDialog').SettingsDialog>
>(() => import('./SettingsDialog').then((m) => ({ default: m.SettingsDialog })));
export const DataMaintenanceDialog = lazyPanel<
  ComponentProps<typeof import('./settings/DataMaintenanceDialog').DataMaintenanceDialog>
>(() =>
  import('./settings/DataMaintenanceDialog').then((m) => ({ default: m.DataMaintenanceDialog })),
);
export const CollectionDialog = lazyPanel<
  ComponentProps<typeof import('./CollectionDialog').CollectionDialog>
>(() => import('./CollectionDialog').then((m) => ({ default: m.CollectionDialog })));
export const QzoneWorkspace = lazyPanel<
  ComponentProps<typeof import('../views/QzoneView').QzoneWorkspace>
>(() => import('../views/QzoneView').then((m) => ({ default: m.QzoneWorkspace })));
export const ChannelView = lazyRetainedPanel<
  ComponentProps<typeof import('../views/ChannelView').ChannelView>
>(() => import('../views/ChannelView').then((m) => ({ default: m.ChannelView })));
export const DressUpDialog = lazyPanel<
  ComponentProps<typeof import('./DressUpDialog').DressUpDialog>
>(() => import('./DressUpDialog').then((m) => ({ default: m.DressUpDialog })));
export const GroupBugDialog = lazyPanel<
  ComponentProps<typeof import('./GroupBugDialog').GroupBugDialog>
>(() => import('./GroupBugDialog').then((m) => ({ default: m.GroupBugDialog })));
export const ExportTool = lazyPanel<
  ComponentProps<typeof import('../views/ExportView').ExportTool>
>(() => import('../views/ExportView').then((m) => ({ default: m.ExportTool })), toolLoading);
export const ExportViewer = lazyPanel<
  ComponentProps<typeof import('../views/ExportViewer').ExportViewer>
>(() => import('../views/ExportViewer').then((m) => ({ default: m.ExportViewer })), toolLoading);
export const AnalysisTool = lazyPanel<
  ComponentProps<typeof import('../views/analysis/AnalysisTool').AnalysisTool>
>(
  () => import('../views/analysis/AnalysisTool').then((m) => ({ default: m.AnalysisTool })),
  toolLoading,
);
export const AnalysisReportsTool = lazyPanel<
  ComponentProps<typeof import('../views/analysis/AnalysisReportsTool').AnalysisReportsTool>
>(
  () =>
    import('../views/analysis/AnalysisReportsTool').then((m) => ({
      default: m.AnalysisReportsTool,
    })),
  toolLoading,
);
export const RoamingBackfillPanel = lazyPanel<
  ComponentProps<typeof import('./RoamingBackfillPanel').RoamingBackfillPanel>
>(
  () => import('./RoamingBackfillPanel').then((m) => ({ default: m.RoamingBackfillPanel })),
  toolLoading,
);
export const AgentLabView = lazyPanel<
  ComponentProps<typeof import('../views/AgentLabView').AgentLabView>
>(() => import('../views/AgentLabView').then((m) => ({ default: m.AgentLabView })));
export const AssistantConversationPane = lazyRetainedPanel<
  ComponentProps<
    typeof import('../views/agentlab/AssistantConversationPane').AssistantConversationPane
  >
>(() =>
  import('../views/agentlab/AssistantConversationPane').then((m) => ({
    default: m.AssistantConversationPane,
  })),
);
export const GuildDirectDialog = lazyPanel<
  ComponentProps<typeof import('./GuildDirectDialog').GuildDirectDialog>
>(() => import('./GuildDirectDialog').then((m) => ({ default: m.GuildDirectDialog })));
export const AnnualReportView = lazyPanel<
  NonNullable<
    ComponentProps<typeof import('../views/annual-report/AnnualReportView').AnnualReportView>
  >
>(() =>
  import('../views/annual-report/AnnualReportView').then((m) => ({ default: m.AnnualReportView })),
);
