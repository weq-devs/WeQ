import { Power } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';

export function StartupSection() {
  const refresh = useQQAutoRefresh(true);
  const status = trpc.bootstrap.getAutostartStatus.useQuery(undefined, refresh);
  const update = trpc.bootstrap.setAutostart.useMutation();
  const showError = useDialog((state) => state.showError);
  const pushToast = useToast((state) => state.push);
  const data = status.data;
  const label = status.error
    ? '读取失败'
    : status.isLoading
      ? '读取中'
      : !data?.supported
        ? '当前环境不支持'
        : data.requiresApproval
          ? '需要系统批准'
          : data.enabled
            ? '已开启'
            : '已关闭';
  async function change(enabled: boolean) {
    try {
      const result = await update.mutateAsync({ enabled });
      await status.refetch();
      pushToast({
        tone: result.requiresApproval ? 'info' : 'success',
        title: result.requiresApproval
          ? '自启需要系统批准'
          : result.enabled
            ? '已开启登录自启'
            : '已关闭登录自启',
      });
    } catch (error) {
      showError('设置登录自启失败', error instanceof Error ? error.message : '系统未应用设置');
      await status.refetch();
    }
  }
  return (
    <div className="weq-set">
      <SectionHeader icon={<Power size={16} />} title="开机启动" />
      <Card title="登录自启">
        <Row
          label="开机自动启动 WeQ"
          desc={
            data?.supported
              ? '登录系统时启动 WeQ，完全退出后不会在本次登录中重新拉起。'
              : '仅安装版桌面端支持；Web 服务由部署方管理。'
          }
          control={
            <Toggle
              label="开机自动启动 WeQ"
              checked={Boolean(data?.enabled || data?.requiresApproval)}
              disabled={!data?.supported || status.isLoading || !!status.error || update.isLoading}
              onChange={(enabled) => void change(enabled)}
            />
          }
        />
        <Row label="系统登录项" desc={label} control={<Power size={14} aria-hidden />} />
        {status.error && <p className="weq-set-note weq-set-note-warn">{status.error.message}</p>}
        {data?.migrationError && (
          <p className="weq-set-note weq-set-note-warn">旧后台迁移未完成：{data.migrationError}</p>
        )}
      </Card>
    </div>
  );
}
