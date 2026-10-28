import { lazyPanel } from '../lib/lazyPanel';
import type { ComponentProps } from 'react';

export const SettingsDialog = lazyPanel<
  ComponentProps<typeof import('./SettingsDialog').SettingsDialog>
>(() => import('./SettingsDialog').then((m) => ({ default: m.SettingsDialog })));
export const DataMaintenanceDialog = lazyPanel<
  ComponentProps<typeof import('./settings/DataMaintenanceSection').DataMaintenanceDialog>
>(() =>
  import('./settings/DataMaintenanceSection').then((m) => ({ default: m.DataMaintenanceDialog })),
);
export const CollectionDialog = lazyPanel<
  ComponentProps<typeof import('./CollectionDialog').CollectionDialog>
>(() => import('./CollectionDialog').then((m) => ({ default: m.CollectionDialog })));
export const QzoneWorkspace = lazyPanel<
  ComponentProps<typeof import('../views/QzoneView').QzoneWorkspace>
>(() => import('../views/QzoneView').then((m) => ({ default: m.QzoneWorkspace })));
export const ChannelView = lazyPanel<
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
>(() => import('../views/ExportView').then((m) => ({ default: m.ExportTool })));
export const ExportViewer = lazyPanel<
  ComponentProps<typeof import('../views/ExportViewer').ExportViewer>
>(() => import('../views/ExportViewer').then((m) => ({ default: m.ExportViewer })));
export const AnalysisTool = lazyPanel<
  ComponentProps<typeof import('../views/analysis/AnalysisTool').AnalysisTool>
>(() => import('../views/analysis/AnalysisTool').then((m) => ({ default: m.AnalysisTool })));
export const RoamingBackfillPanel = lazyPanel<
  ComponentProps<typeof import('./RoamingBackfillPanel').RoamingBackfillPanel>
>(() => import('./RoamingBackfillPanel').then((m) => ({ default: m.RoamingBackfillPanel })));

const navigation = {
  settings: SettingsDialog,
  maintenance: DataMaintenanceDialog,
  collections: CollectionDialog,
  qzone: QzoneWorkspace,
  channel: ChannelView,
  dressup: DressUpDialog,
  export: ExportTool,
  viewer: ExportViewer,
  analysis: AnalysisTool,
  backfill: RoamingBackfillPanel,
};
export function preloadWorkspace(name: string): void {
  if (Object.hasOwn(navigation, name))
    void navigation[name as keyof typeof navigation].preload().catch(() => {});
}
