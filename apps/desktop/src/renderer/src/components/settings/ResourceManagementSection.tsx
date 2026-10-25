import { useState } from 'react';
import { BarChart3, FolderOpen, Trash2 } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useViewState } from '../../state/view';
import { RetainedTabs, TabActivity, useTabActive } from '../RetainedTabs';
import { SegmentedControl } from '../SegmentedControl';
import { SectionHeader, QueryError } from './controls';
import { CacheView } from '../../views/cache/CacheView';
import { ResourceAnalyticsDialog } from '../../views/cache/ResourceAnalyticsDialog';
import { ResourceCleanupDialog } from '../../views/cache/ResourceCleanupDialog';
import { useResourceManagementScan } from '../../views/cache/useResourceManagementScan';
import { RESOURCE_CATEGORIES, type ResourceSource } from '../../views/cache/resourceManagement';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
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
      <SectionHeader title="资源目录管理" />
      {account.error ? (
        <QueryError
          message={account.error.message}
          retryLabel="重新读取来源"
          onRetry={() => void account.refetch()}
        />
      ) : null}
      {account.data?.static ? (
        <p role="status" className="weq-resource-status">
          静态账号不提供本机 QQ 资源维护，这些目录不属于导入的数据库快照。
        </p>
      ) : source ? (
        <TabActivity active={active && !account.error}>
          <ResourceManagementBody
            key={JSON.stringify([source.expectedAccountUin, source.expectedAccountConfigId])}
            source={source}
          />
        </TabActivity>
      ) : !account.error ? (
        <p role="status" className="weq-resource-status">
          正在读取当前账号与数据源…
        </p>
      ) : null}
    </div>
  );
}

function ResourceManagementBody({ source }: { source: ResourceSource }) {
  const activity = useQQReadActivity(true, { onlineOnly: false });
  const [view, setView] = useState<ResourceView>('overview');
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
      <SegmentedControl<ResourceView>
        label="资源管理视图"
        value={view}
        onChange={setView}
        options={[
          {
            value: 'overview',
            label: (
              <span data-setting-id="qq-storage-analysis">
                <BarChart3 size={15} />
                占用概览
              </span>
            ),
          },
          {
            value: 'cleanup',
            label: (
              <span data-setting-id="qq-storage-cleanup">
                <Trash2 size={15} />
                资源清理
              </span>
            ),
          },
          {
            value: 'browse',
            label: (
              <span data-setting-id="resource-viewer">
                <FolderOpen size={15} />
                资源浏览
              </span>
            ),
          },
        ]}
      />
      {busy ? (
        <p className="weq-resource-status" role="status">
          QQ 资源清理正在执行
        </p>
      ) : progress && view !== 'overview' ? (
        <p className="weq-resource-status" role="status">
          正在扫描{progress} · {scan.stats.length} / {RESOURCE_CATEGORIES.length + 1}
        </p>
      ) : null}
      <RetainedTabs activeKey={view}>
        <div key={view} className="weq-resource-panel" data-resource-panel={view}>
          {view === 'overview' ? (
            <>
              <ResourceAnalyticsDialog open embedded snapshot={snapshot} onClose={() => {}} />
              <section className="weq-resource-mapping">
                <h3>分类与清理范围</h3>
                {RESOURCE_CATEGORIES.map((category) => (
                  <div className="weq-resource-map-row" key={category.key}>
                    <strong>{category.label}</strong>
                    <span>
                      {scan.complete
                        ? category.cleanup
                            .map(
                              (id) => scan.targets.find((target) => target.id === id)?.label ?? id,
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
                <p>
                  总量只计算顶层分析目录，表情子目标不重复累加。批量清理不删除系统表情资源、表情包元数据或主动下载文件。
                </p>
              </section>
            </>
          ) : view === 'cleanup' ? (
            <ResourceCleanupDialog
              open
              embedded
              snapshot={snapshot}
              onBusyChange={setBusy}
              onClose={() => setView('overview')}
            />
          ) : (
            <>
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
            </>
          )}
        </div>
      </RetainedTabs>
    </div>
  );
}
