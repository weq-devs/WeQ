import { PanelsTopLeft } from 'lucide-react';
import { supportsWindowsStyleControls } from '../../../../shared/window_controls';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useTabActive } from '../RetainedTabs';
import { Card, Row, Toggle } from './controls';

export function WindowAppearanceCard() {
  const active = useTabActive();
  const platform = window.electron?.process.platform;
  const supported = !!platform && supportsWindowsStyleControls(platform);
  const showError = useDialog((state) => state.showError);
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active && supported,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const update = trpc.bootstrap.setWindowsStyleControls.useMutation();

  if (!supported) return null;

  return (
    <Card
      title="窗口外观"
      icon={<PanelsTopLeft size={15} strokeWidth={1.8} />}
      resetId="window-appearance"
      remoteUnsupported
    >
      <Row
        settingId="windows-style-controls"
        label={
          <span className="weq-set-row-icon">
            <PanelsTopLeft size={15} strokeWidth={1.8} aria-hidden />
            使用仿 Windows 窗口按钮
          </span>
        }
        desc={`在右上角使用最小化、最大化和关闭按钮，替代系统窗口按钮；账号选择页保持统一样式。${platform === 'linux' ? '主窗口重新进入账号后生效，独立窗口下次打开时生效。' : '主窗口立即生效，独立窗口下次打开时生效。'}`}
        control={
          <Toggle
            label="使用仿 Windows 窗口按钮"
            checked={settings.data?.windowsStyleControls ?? false}
            disabled={settings.isLoading || settings.isError || update.isLoading}
            onChange={(enabled) => {
              void update
                .mutateAsync({ enabled })
                .then(() => settings.refetch())
                .catch((error: unknown) =>
                  showError(
                    '保存窗口按钮设置失败',
                    error instanceof Error ? error.message : String(error),
                  ),
                );
            }}
          />
        }
      />
    </Card>
  );
}
