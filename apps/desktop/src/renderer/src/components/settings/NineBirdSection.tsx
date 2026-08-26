/**
 * 设置 → NineBird（macOS）
 *
 * 移植 napcat-mac-installer 的机制：把 NineBird 的 hooker + loader 部署进
 * QQ 沙箱容器，并把 `/Applications/QQ.app/…/package.json` 的 main 指向容器
 * 内的 `loadNineBird.js`（提权操作，napcat 同款 `sudo -S`：渲染层弹密码框，
 * 密码经 stdin 喂给 sudo，WeQ 自身保持非特权）。安装完成后，扫码 / 快捷登录
 * 流程即可在 macOS 上拉起 QQ 取 dbkey。
 *
 * 非 macOS 平台渲染为空（导航入口由 SettingsDialog 按平台过滤）。
 */

import type { ReactElement } from 'react';
import { Loader2, Plug, RefreshCw, Trash2 } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader } from './controls';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const STATUS_TEXT: Record<string, string> = {
  missing: '未安装',
  original: '原版 QQ',
  ninebird: '已安装（NineBird 入口）',
  custom: '自定义入口',
  failed: '读取失败',
};

export function NineBirdSection(): ReactElement | null {
  const showError = useDialog((s) => s.showError);
  const promptPassword = useDialog((s) => s.promptPassword);
  const pushToast = useToast((s) => s.push);

  const systemInfo = trpc.bootstrap.systemInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const status = trpc.bootstrap.nineBirdInstallStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const install = trpc.bootstrap.nineBirdInstall.useMutation();
  const uninstall = trpc.bootstrap.nineBirdUninstall.useMutation();

  if (systemInfo.data?.platformKind !== 'darwin') {
    return null;
  }

  const state = status.data ?? { kind: 'missing' as const };
  const busy = install.isPending || uninstall.isPending;

  const doInstall = async (): Promise<void> => {
    const password = await promptPassword(
      'NineBird 安装',
      '需要管理员权限修改 QQ 程序入口（/Applications/QQ.app/Contents/Resources/app/package.json），' +
        '请输入电脑开机密码。',
      { placeholder: '管理员密码' },
    );
    if (password === null) return;
    try {
      await install.mutateAsync({ password });
      pushToast({
        tone: 'success',
        title: 'NineBird 安装成功',
        detail: '已切换到 NineBird 程序入口。',
      });
      status.refetch();
    } catch (e) {
      showError('NineBird 安装失败', errMsg(e));
      status.refetch();
    }
  };

  const doUninstall = async (): Promise<void> => {
    const password = await promptPassword(
      '还原原版 QQ',
      '需要管理员权限恢复 QQ 的原始程序入口，请输入电脑开机密码。',
      { placeholder: '管理员密码' },
    );
    if (password === null) return;
    try {
      await uninstall.mutateAsync({ password });
      pushToast({ tone: 'success', title: '已还原原版 QQ 入口' });
      status.refetch();
    } catch (e) {
      showError('还原失败', errMsg(e));
      status.refetch();
    }
  };

  return (
    <section>
      <SectionHeader
        icon={<Plug size={16} />}
        title="NineBird（macOS）"
        desc="安装后可用扫码 / 快捷登录自动提取数据库密钥。首次安装需要输入管理员密码以修改 QQ 程序入口。"
      />
      <Card>
        <Row
          label="QQ 程序入口"
          desc={state.kind === 'failed' ? state.error : undefined}
          control={
            <span className="weq-set-row-label">
              {status.isLoading ? '读取中…' : (STATUS_TEXT[state.kind] ?? state.kind)}
            </span>
          }
        />
        <Row
          label="安装 / 还原"
          desc="NineBird 文件部署在 QQ 容器 Documents/weq-ninebird 下，卸载时一并删除。"
          control={
            <span style={{ display: 'inline-flex', gap: 8 }}>
              {state.kind !== 'ninebird' ? (
                <button
                  type="button"
                  className="weq-set-seg-item"
                  disabled={busy || status.isLoading}
                  onClick={() => void doInstall()}
                >
                  {install.isPending ? <Loader2 size={14} className="is-spin" /> : null}
                  安装
                </button>
              ) : null}
              {state.kind === 'ninebird' ? (
                <button
                  type="button"
                  className="weq-set-seg-item"
                  disabled={busy}
                  onClick={() => void doUninstall()}
                >
                  {uninstall.isPending ? <Loader2 size={14} className="is-spin" /> : null}
                  <Trash2 size={14} />
                  还原原版
                </button>
              ) : null}
              <button
                type="button"
                className="weq-set-seg-item"
                disabled={busy}
                onClick={() => status.refetch()}
                aria-label="刷新状态"
              >
                <RefreshCw size={14} />
              </button>
            </span>
          }
        />
      </Card>
      <p className="weq-set-desc">
        提示：如提示「not permitted」，请在 系统设置 → 隐私与安全性 → App 管理 中添加 WeQ 后重试。
      </p>
    </section>
  );
}
