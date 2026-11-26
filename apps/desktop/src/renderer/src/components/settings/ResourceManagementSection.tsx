import { useState } from 'react';
import { z } from 'zod/v3';
import { usePageState } from '../PageSnapshots.shared';
import { BarChart3, FolderOpen, HardDrive, Layers, Trash2 } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useViewState } from '../../state/view';
import { RetainedTabs, TabActivity } from '../RetainedTabs';
import { useTabActive } from '../RetainedTabs.shared';
import { SegmentedControl } from '../SegmentedControl';
import { Card, SectionHeader, QueryError } from './controls';
import { EmptyState } from '../EmptyState';
import { PanelLoading } from '../LoadingIndicator';
import { CacheView } from '../../views/cache/CacheView';
import { ResourceAnalyticsDialog } from '../../views/cache/ResourceAnalyticsDialog';
import { ResourceCleanupDialog } from '../../views/cache/ResourceCleanupDialog';
import { useResourceManagementScan } from '../../views/cache/useResourceManagementScan';
import { RESOURCE_CATEGORIES, type ResourceSource } from '../../views/cache/resourceManagement';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { useRemoteClient } from '../../lib/remoteClient';
import '../../styles/cache.css';
import '../../styles/settings-resources.css';

type ResourceView = 'overview' | 'cleanup' | 'browse';

export function ResourceManagementSection() {
  const active = useTabActive();
  const uin = useViewState((state) => state.openedUin);
  const account = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const source =
    uin && account.data?.uin === uin && account.data.configId
      ? { expectedAccountUin: uin, expectedAccountConfigId: account.data.configId }
      : null;
  return (
    <div className="weq-set weq-resources-settings">
      <SectionHeader title="QQ 资源管理" page="qq-storage" />
      {account.error ? (
        <QueryError
          message={account.error.message}
          retryLabel="重新读取来源"
          onRetry={() => void account.refetch()}
        />
      ) : null}
      {account.data?.static ? (
        <Card>
          <EmptyState
            icon={<HardDrive />}
            title="该备份没有关联的 QQ 资源目录"
            body="导入的数据库快照可以用来查看聊天记录。要浏览或清理 QQ 缓存，请打开本机的 QQ 账号。"
          />
        </Card>
      ) : source ? (
        <TabActivity active={active && !account.error}>
          <ResourceManagementBody
            key={JSON.stringify([source.expectedAccountUin, source.expectedAccountConfigId])}
            source={source}
          />
        </TabActivity>
      ) : !account.error ? (
        <PanelLoading>正在读取当前账号与数据源…</PanelLoading>
      ) : null}
    </div>
  );
}

function ResourceManagementBody({ source }: { source: ResourceSource }) {
  const remote = useRemoteClient();
  const activity = useQQReadActivity(true, { onlineOnly: false });
  const [view, setView] = usePageState<ResourceView>(
    'resources:view',
    'overview',
    z.enum(['overview', 'cleanup', 'browse']),
  );
  const currentView = remote && view === 'cleanup' ? 'overview' : view;
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<{ category: string }>();
  const scan = useResourceManagementScan(source, activity.enabled);
  if (!scan) return null;
  const snapshot = { ...scan, cleanupRunning: busy };
  const progress =
    scan.scanningKey === 'cleanup'
      ? '清理目标'
      : RESOURCE_CATEGORIES.find((category) => category.key === scan.scanningKey)?.label;
  return (
    <div className="weq-resource-management">
      <Card>
        <div>
          <SegmentedControl<ResourceView>
            label="资源管理视图"
            value={currentView}
            onChange={setView}
            options={[
              {
                value: 'overview' as const,
                label: (
                  <span className="weq-set-seg-label" data-setting-id="qq-storage-analysis">
                    <BarChart3 size={15} />
                    占用概览
                  </span>
                ),
              },
              {
                value: 'cleanup' as const,
                label: (
                  <span className="weq-set-seg-label" data-setting-id="qq-storage-cleanup">
                    <Trash2 size={15} />
                    资源清理
                  </span>
                ),
              },
              {
                value: 'browse' as const,
                label: (
                  <span className="weq-set-seg-label" data-setting-id="resource-viewer">
                    <FolderOpen size={15} />
                    资源浏览
                  </span>
                ),
              },
            ].filter((option) => !remote || option.value !== 'cleanup')}
          />
        </div>
        {busy ? (
          <p className="weq-resource-status" role="status">
            QQ 资源清理正在执行
          </p>
        ) : progress && currentView !== 'overview' ? (
          <p className="weq-resource-status" role="status">
            正在扫描<span className="weq-number weq-number-inherit">{progress}</span> ·{' '}
            <span className="weq-number weq-number-inherit">{scan.stats.length}</span> /{' '}
            <span className="weq-number weq-number-inherit">{RESOURCE_CATEGORIES.length + 1}</span>
          </p>
        ) : null}
      </Card>
      <RetainedTabs snapshotKey="resource-management" activeKey={currentView} animateSwitch>
        <div key={currentView} className="weq-resource-panel" data-resource-panel={currentView}>
          {currentView === 'overview' ? (
            <>
              <ResourceAnalyticsDialog open embedded snapshot={snapshot} onClose={() => {}} />
              <Card title="分类与清理范围" icon={<Layers size={15} strokeWidth={1.8} />}>
                <div className="weq-resource-mapping">
                  {RESOURCE_CATEGORIES.map((category) => (
                    <div className="weq-resource-map-row" key={category.key}>
                      <strong>{category.label}</strong>
                      <span>
                        {scan.complete
                          ? category.cleanup
                              .map(
                                (id) =>
                                  scan.targets.find((target) => target.id === id)?.label ?? id,
                              )
                              .join('、')
                          : '等待扫描清理目标'}
                      </span>
                      <button
                        type="button"
                        className="weq-set-btn"
                        onClick={() => {
                          setSelection({ category: category.browse[0] });
                          setView('browse');
                        }}
                      >
                        <FolderOpen size={14} />
                        浏览
                      </button>
                    </div>
                  ))}
                </div>
                <p className="weq-set-note">
                  总量只计算顶层分析目录，表情子目标不重复累加。批量清理不删除系统表情资源、表情包元数据或主动下载文件。
                </p>
              </Card>
            </>
          ) : currentView === 'cleanup' ? (
            <ResourceCleanupDialog
              open
              embedded
              snapshot={snapshot}
              onBusyChange={setBusy}
              onClose={() => setView('overview')}
            />
          ) : (
            <Card title="资源浏览" icon={<FolderOpen size={15} strokeWidth={1.8} />}>
              {scan.error ? (
                <QueryError
                  message={scan.error}
                  retryLabel="重新扫描"
                  onRetry={() => void scan.refresh()}
                />
              ) : null}
              <div className="weq-resource-browser">
                <CacheView selection={selection} revision={scan.revision} />
              </div>
            </Card>
          )}
        </div>
      </RetainedTabs>
    </div>
  );
}
