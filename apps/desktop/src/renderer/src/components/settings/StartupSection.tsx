import { Minimize2, PlayCircle, Power } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { WindowCloseBehavior } from '@weq/service';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useDialog } from '../Dialog.shared';
import { useToast } from '../Toast.shared';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { SegmentedControl } from '../SegmentedControl';
import { DesktopOnly } from '../../lib/target';
import { IS_WEB } from '../../lib/target.shared';

const CLOSE_BEHAVIOR_OPTIONS = [
  { value: 'ask', label: '每次询问' },
  { value: 'tray', label: '最小化到托盘' },
  { value: 'quit', label: '直接退出' },
] as const;

export function StartupSection() {
  const refresh = useQQAutoRefresh(true);
  const status = trpc.bootstrap.getAutostartStatus.useQuery(undefined, refresh);
  const update = trpc.bootstrap.setAutostart.useMutation();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, refresh);
  const windowUpdate = trpc.bootstrap.setShowWindowOnAutostart.useMutation();
  const pageUpdate = trpc.bootstrap.setStartupPage.useMutation();
  const closeUpdate = trpc.bootstrap.setWindowCloseBehavior.useMutation();
  const [closeBehavior, setCloseBehavior] = useState<WindowCloseBehavior>('tray');
  const assistant = trpc.bootstrap.getWeqAssistantStatus.useQuery(undefined, refresh);
  const confirm = useDialog((state) => state.confirm);
  const [changing, setChanging] = useState(false);
  const changingRef = useRef(false);
  const showError = useDialog((state) => state.showError);
  const pushToast = useToast((state) => state.push);
  const data = status.data;
  useEffect(() => {
    const behavior = settings.data?.windowCloseBehavior;
    if (behavior) setCloseBehavior(behavior);
  }, [settings.data?.windowCloseBehavior]);

  async function changeCloseBehavior(behavior: WindowCloseBehavior) {
    const previous = closeBehavior;
    setCloseBehavior(behavior);
    try {
      await closeUpdate.mutateAsync({ behavior });
      await settings.refetch();
    } catch (error) {
      setCloseBehavior(previous);
      await settings.refetch();
      showError('保存关闭行为设置失败', error instanceof Error ? error.message : String(error));
    }
  }
  const autostartDescription = status.error
    ? '读取开机启动状态失败。'
    : status.isLoading
      ? '正在读取开机启动状态…'
      : !data?.supported
        ? '仅安装版桌面端支持；Web 服务由部署方管理。'
        : data.readOnly
          ? '各账号共用此状态，可在 WeQ 主窗口修改。'
          : data.requiresApproval
            ? '需要系统批准，批准后将在登录系统时启动 WeQ。'
            : '登录系统时启动 WeQ，完全退出后不会在本次登录中重新拉起。';
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
      <SectionHeader page="startup" title="启动与退出" />
      <Card title="开机启动" icon={<Power size={15} strokeWidth={1.8} />} remoteUnsupported>
        <Row
          settingId="startup-enabled"
          desc={autostartDescription}
          control={
            <Toggle
              label="开机自动启动"
              checked={Boolean(data?.enabled || data?.requiresApproval)}
              disabled={
                !data?.supported ||
                data.readOnly ||
                status.isLoading ||
                !!status.error ||
                update.isLoading ||
                changing
              }
              onChange={(enabled) => void change(enabled)}
            />
          }
        />
        {status.error && <p className="weq-set-note weq-set-note-warn">{status.error.message}</p>}
        {data?.enabled || data?.requiresApproval ? (
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
                  data.readOnly ||
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
        ) : null}
        {settings.error && (
          <p className="weq-set-note weq-set-note-warn">{settings.error.message}</p>
        )}
        {data?.migrationError && (
          <p className="weq-set-note weq-set-note-warn">旧后台迁移未完成：{data.migrationError}</p>
        )}
      </Card>
      <Card
        title="启动时进入"
        desc={IS_WEB ? '浏览器模式下，窗口关闭行为由浏览器管理。' : undefined}
        icon={<PlayCircle size={15} strokeWidth={1.8} />}
        resetId="startup-page"
      >
        <Row
          settingId="startup-page"
          label="启动后打开"
          control={
            <SegmentedControl
              label="启动时进入"
              value={settings.data?.startupPage ?? 'home'}
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
      <DesktopOnly>
        <Card
          title="关闭窗口"
          icon={<Minimize2 size={15} strokeWidth={1.8} />}
          resetId="window"
          remoteUnsupported
        >
          <Row
            settingId="window-close-behavior"
            label="关闭按钮"
            desc={
              closeBehavior === 'tray'
                ? '点击关闭按钮后最小化到系统托盘，进程常驻后台，可从托盘图标恢复。'
                : closeBehavior === 'quit'
                  ? '点击关闭按钮后直接完全退出应用。'
                  : '每次点击关闭按钮时弹窗询问，可选择最小化到托盘或完全退出。'
            }
            control={
              <SegmentedControl
                label="关闭按钮行为"
                value={closeBehavior}
                disabled={settings.isLoading || settings.isError || closeUpdate.isLoading}
                options={CLOSE_BEHAVIOR_OPTIONS}
                onChange={(behavior) => void changeCloseBehavior(behavior)}
              />
            }
          />
        </Card>
      </DesktopOnly>
    </div>
  );
}
