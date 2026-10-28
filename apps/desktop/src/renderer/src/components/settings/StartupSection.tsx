import { Power } from 'lucide-react';
import { useRef, useState } from 'react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { SegmentedControl } from '../SegmentedControl';

export function StartupSection() {
  const refresh = useQQAutoRefresh(true);
  const status = trpc.bootstrap.getAutostartStatus.useQuery(undefined, refresh);
  const update = trpc.bootstrap.setAutostart.useMutation();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, refresh);
  const windowUpdate = trpc.bootstrap.setShowWindowOnAutostart.useMutation();
  const pageUpdate = trpc.bootstrap.setStartupPage.useMutation();
  const assistant = trpc.bootstrap.getWeqAssistantStatus.useQuery(undefined, refresh);
  const confirm = useDialog((state) => state.confirm);
  const [changing, setChanging] = useState(false);
  const changingRef = useRef(false);
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
    if (changingRef.current) return;
    changingRef.current = true;
    setChanging(true);
    try {
      if (!enabled && (await assistant.refetch())?.data?.enabled) {
        const keep = await confirm(
          'QQ 公众号推送仍处于启用状态',
          '关闭登录自启后，下次登录系统不会自动打开 WeQ，推文卡片需要手动启动 WeQ 后才能加载。是否保留登录自启？',
          { okLabel: '保留自启', cancelLabel: '仍关闭自启', tone: 'warning' },
        );
        if (keep) return;
      }
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
    } finally {
      changingRef.current = false;
      setChanging(false);
    }
  }
  async function changeWindow(enabled: boolean) {
    try {
      await windowUpdate.mutateAsync({ enabled });
      await settings.refetch();
      pushToast({ tone: 'success', title: enabled ? '自启时显示窗口' : '自启时保持后台运行' });
    } catch (error) {
      showError('保存自启窗口设置失败', error instanceof Error ? error.message : '设置未保存');
      await settings.refetch();
    }
  }
  return (
    <div className="weq-set">
      <SectionHeader icon={<Power size={16} />} title="启动" />
      <Card>
        <Row
          settingId="startup-page"
          label="启动时进入"
          control={
            <SegmentedControl
              label="启动时进入"
              value={settings.data?.startupPage ?? 'last'}
              disabled={settings.isLoading || !!settings.error || pageUpdate.isLoading}
              options={
                [
                  { value: 'home', label: '主页' },
                  { value: 'messages', label: '消息' },
                  { value: 'last', label: '上次退出时所在页面' },
                ] as const
              }
              onChange={(page) => {
                void pageUpdate.mutateAsync({ page }).then(
                  () => settings.refetch(),
                  (error: unknown) => {
                    showError(
                      '保存启动页面失败',
                      error instanceof Error ? error.message : '设置未保存',
                    );
                  },
                );
              }}
            />
          }
        />
      </Card>
      <Card title="开机启动">
        <Row
          settingId="startup-enabled"
          label="开机自动启动"
          desc={
            data?.supported
              ? '登录系统时启动 WeQ，完全退出后不会在本次登录中重新拉起。'
              : '仅安装版桌面端支持；Web 服务由部署方管理。'
          }
          control={
            <Toggle
              label="开机自动启动"
              checked={Boolean(data?.enabled || data?.requiresApproval)}
              disabled={
                !data?.supported ||
                status.isLoading ||
                !!status.error ||
                update.isLoading ||
                changing
              }
              onChange={(enabled) => void change(enabled)}
            />
          }
        />
        <Row
          label="自启时显示窗口"
          desc="默认关闭，自启后在托盘中运行；手动打开 WeQ 时仍显示窗口。"
          indent
          control={
            <Toggle
              label="自启时显示窗口"
              checked={settings.data?.showWindowOnAutostart ?? false}
              disabled={
                !data?.supported ||
                !(data.enabled || data.requiresApproval) ||
                status.isLoading ||
                !!status.error ||
                settings.isLoading ||
                !!settings.error ||
                update.isLoading ||
                windowUpdate.isLoading
              }
              onChange={(enabled) => void changeWindow(enabled)}
            />
          }
        />
        <Row label="系统登录项" desc={label} control={<Power size={14} aria-hidden />} />
        {status.error && <p className="weq-set-note weq-set-note-warn">{status.error.message}</p>}
        {settings.error && (
          <p className="weq-set-note weq-set-note-warn">{settings.error.message}</p>
        )}
        {data?.migrationError && (
          <p className="weq-set-note weq-set-note-warn">旧后台迁移未完成：{data.migrationError}</p>
        )}
      </Card>
    </div>
  );
}
