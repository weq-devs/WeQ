import type { ReactElement } from 'react';
import { ArrowRight, ArrowUpRight, HardDrive, RefreshCw } from 'lucide-react';
import { Row, SectionHeader } from './controls';
import { useTabActive } from '../RetainedTabs.shared';
import { trpc } from '../../trpc/client';
import '../../styles/data-maintenance.css';
import { useRemoteClient } from '../../lib/remoteClient';
import {
  type MaintenanceTool,
  MAINTENANCE_TOOLS,
  remoteUnsupportedTools,
} from './DataMaintenanceSection.shared';

export function DataMaintenanceSection({
  onOpen,
  tools,
  title = '维护工具',
}: {
  onOpen: (tool: MaintenanceTool) => void;
  tools?: readonly MaintenanceTool[];
  title?: string | null;
}): ReactElement {
  const active = useTabActive();
  const remote = useRemoteClient();
  const account = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: active,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const visibleTools = tools
    ? tools.flatMap((id) => MAINTENANCE_TOOLS.filter((tool) => tool.id === id))
    : MAINTENANCE_TOOLS.filter((tool) => tool.id !== 'login-accounts');
  return (
    <div className="weq-set weq-data-maintenance">
      {title ? (
        <SectionHeader
          title={title}
          icon={<HardDrive size={16} strokeWidth={1.8} />}
          desc={tools?.includes('login-accounts') ? undefined : '当前账号'}
        />
      ) : null}
      {account.isError ? (
        <div role="alert" className="weq-maintenance-status">
          {account.error.message}
          <button type="button" className="weq-set-btn" onClick={() => void account.refetch()}>
            <RefreshCw size={14} aria-hidden="true" />
            重试
          </button>
        </div>
      ) : null}
      <div className="weq-maintenance-rows">
        {visibleTools
          .filter(({ id }) => !remote || !remoteUnsupportedTools.includes(id))
          .map(({ id, label, actionLabel, settingId, needsResources }) => {
            const unavailable = needsResources && account.data?.static;
            const OpenIcon = id === 'db-repair' || id === 'database' ? ArrowUpRight : ArrowRight;
            return (
              <Row
                key={id}
                label={label}
                desc={unavailable ? '静态账号不可用' : undefined}
                control={
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    data-setting-id={settingId}
                    onClick={() => onOpen(id)}
                    disabled={!account.data || account.isFetching || account.isError || unavailable}
                    title={unavailable ? '静态账号暂不支持本地资源维护' : undefined}
                  >
                    {actionLabel}
                    <OpenIcon size={14} aria-hidden />
                  </button>
                }
              />
            );
          })}
      </div>
      {!account.data && !account.isError ? (
        <div role="status" className="weq-maintenance-status">
          正在读取当前账号…
        </div>
      ) : null}
    </div>
  );
}
export type { MaintenanceTool } from './DataMaintenanceSection.shared';
