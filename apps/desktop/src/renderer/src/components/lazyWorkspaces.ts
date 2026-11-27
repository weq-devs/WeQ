import { createElement, type ComponentProps } from 'react';
import { lazyPanel, lazyRetainedPanel } from '../lib/lazyPanel';
import { surfaceLoading } from './DeferredSurfaceLoading.shared';
import { DeferredSurfaceLoading } from './DeferredSurfaceLoading';
import { PanelLoading } from './LoadingIndicator';

const settingsLoading = surfaceLoading('设置', { presentation: 'page', standalone: true });

export const SettingsDialog = lazyPanel<
  ComponentProps<typeof import('./SettingsDialog').SettingsDialog>
>(
  () => import('./SettingsDialog').then((m) => ({ default: m.SettingsDialog })),
  (props) => (props.nativeWindow ? createElement(PanelLoading) : settingsLoading(props)),
);
export const DataMaintenanceDialog = lazyPanel<
  ComponentProps<typeof import('./settings/DataMaintenanceDialog').DataMaintenanceDialog>
>(
  () =>
    import('./settings/DataMaintenanceDialog').then((m) => ({ default: m.DataMaintenanceDialog })),
  surfaceLoading('数据维护', { width: 720 }),
);
export const CollectionDialog = lazyPanel<
  ComponentProps<typeof import('./CollectionDialog').CollectionDialog>
>(
  () => import('./CollectionDialog').then((m) => ({ default: m.CollectionDialog })),
  surfaceLoading('收藏'),
);
export const QzoneWorkspace = lazyPanel<
  ComponentProps<typeof import('../views/QzoneView').QzoneWorkspace>
>(() => import('../views/QzoneView').then((m) => ({ default: m.QzoneWorkspace })), 'inline');
export const ChannelView = lazyRetainedPanel<
  ComponentProps<typeof import('../views/ChannelView').ChannelView>
>(() => import('../views/ChannelView').then((m) => ({ default: m.ChannelView })));
export const DressUpDialog = lazyPanel<
  ComponentProps<typeof import('./DressUpDialog').DressUpDialog>
>(
  () => import('./DressUpDialog').then((m) => ({ default: m.DressUpDialog })),
  surfaceLoading('个性装扮', {
    presentation: 'page',
    standalone: true,
    keepMobileNavigation: true,
  }),
);
export const GroupBugDialog = lazyPanel<
  ComponentProps<typeof import('./GroupBugDialog').GroupBugDialog>
>(
  () => import('./GroupBugDialog').then((m) => ({ default: m.GroupBugDialog })),
  surfaceLoading('群问题反馈', { width: 560 }),
);
export const ExportTool = lazyPanel<
  ComponentProps<typeof import('../views/ExportView').ExportTool>
>(() => import('../views/ExportView').then((m) => ({ default: m.ExportTool })), 'inline');
export const ExportViewer = lazyPanel<
  ComponentProps<typeof import('../views/ExportViewer').ExportViewer>
>(() => import('../views/ExportViewer').then((m) => ({ default: m.ExportViewer })), 'inline');
export const AnalysisTool = lazyPanel<
  ComponentProps<typeof import('../views/analysis/AnalysisTool').AnalysisTool>
>(
  () => import('../views/analysis/AnalysisTool').then((m) => ({ default: m.AnalysisTool })),
  'inline',
);
export const AnalysisReportsTool = lazyPanel<
  ComponentProps<typeof import('../views/analysis/AnalysisReportsTool').AnalysisReportsTool>
>(
  () =>
    import('../views/analysis/AnalysisReportsTool').then((m) => ({
      default: m.AnalysisReportsTool,
    })),
  'inline',
);
export const RoamingBackfillPanel = lazyPanel<
  ComponentProps<typeof import('./RoamingBackfillPanel').RoamingBackfillPanel>
>(
  () => import('./RoamingBackfillPanel').then((m) => ({ default: m.RoamingBackfillPanel })),
  'inline',
);
export const AgentLabView = lazyPanel<
  ComponentProps<typeof import('../views/AgentLabView').AgentLabView>
>(() => import('../views/AgentLabView').then((m) => ({ default: m.AgentLabView })), 'inline');
export const CloneCreationDialog = lazyPanel<
  ComponentProps<typeof import('../views/agentlab/CloneCreationDialog').CloneCreationDialog>
>(
  () =>
    import('../views/agentlab/CloneCreationDialog').then((m) => ({
      default: m.CloneCreationDialog,
    })),
  ({ request, onClose }) =>
    createElement(DeferredSurfaceLoading, {
      title: request.kind === 'group' ? '新建克隆体群聊' : '新建好友克隆',
      centered: true,
      width: 520,
      onClose,
    }),
);
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
>(
  () => import('./GuildDirectDialog').then((m) => ({ default: m.GuildDirectDialog })),
  surfaceLoading('频道私聊'),
);
export const AnnualReportView = lazyPanel<
  NonNullable<
    ComponentProps<typeof import('../views/annual-report/AnnualReportView').AnnualReportView>
  >
>(
  () =>
    import('../views/annual-report/AnnualReportView').then((m) => ({
      default: m.AnnualReportView,
    })),
  'inline',
);
