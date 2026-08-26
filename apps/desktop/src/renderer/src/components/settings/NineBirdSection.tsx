/**
 * 设置 → NineBird（macOS / Linux）
 *
 * - macOS：移植 napcat-mac-installer 的机制，把 NineBird 的 hooker + loader
 *   部署进 QQ 沙箱容器，并把 `/Applications/QQ.app/…/package.json` 的 main
 *   指向 bundle 里的 `loadNineBird.js`（提权操作，`sudo -S`：渲染层弹密码框，
 *   密码经 stdin 喂给 sudo，WeQ 自身保持非特权）。
 * - Linux：只有 `loadNineBird.js` 一个文件需要提权处理（不碰 package.json），
 *   安装 = 提权写入持久 stub，还原 = 提权删除。
 *
 * 非 macOS / Linux 平台渲染为空（导航入口由 SettingsDialog 按平台过滤）。
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
  ninebird: '已安装',
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

  const isDarwin = systemInfo.data?.platformKind === 'darwin';
  const isLinux = systemInfo.data?.platformKind === 'linux';
  if (!isDarwin && !isLinux) {
    return null;
  }

  const state = status.data ?? { kind: 'missing' as const };
  const busy = install.isPending || uninstall.isPending;
  // Linux：旧版自删 stub（fresh=false）会在下次启动时自动重写，这里也允许
  // 直接重装迁移。
  const needsInstall = state.kind !== 'ninebird' || state.fresh === false;
  const target =
    isDarwin && state.kind === 'ninebird' && 'main' in state && typeof state.main === 'string'
      ? state.main
      : undefined;

  const doInstall = async (): Promise<void> => {
    const password = await promptPassword(
      'NineBird 安装',
      isDarwin
        ? '需要管理员权限修改 QQ 程序入口（/Applications/QQ.app/Contents/Resources/app/package.json），' +
            '请输入电脑开机密码。'
        : '需要管理员权限向 QQ 的启动目录写入入口文件（loadNineBird.js），请输入管理员密码。',
      { placeholder: '管理员密码' },
    );
    if (password === null) return;
    try {
      await install.mutateAsync({ password });
      pushToast({
        tone: 'success',
        title: 'NineBird 安装成功',
        detail: isDarwin ? '已切换到 NineBird 程序入口。' : '已写入 loadNineBird.js。',
      });
      status.refetch();
    } catch (e) {
      showError('NineBird 安装失败', errMsg(e));
      status.refetch();
    }
  };

  const doUninstall = async (): Promise<void> => {
    const password = await promptPassword(
      '还原 NineBird',
      isDarwin
        ? '需要管理员权限恢复 QQ 的原始程序入口，请输入电脑开机密码。'
        : '需要管理员权限删除 QQ 启动目录里的 loadNineBird.js，还原为原版启动方式。请输入管理员密码。',
      { placeholder: '管理员密码' },
    );
    if (password === null) return;
    try {
      await uninstall.mutateAsync({ password });
      pushToast({ tone: 'success', title: '已还原原版 QQ 启动方式' });
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
        title={isDarwin ? 'NineBird（macOS）' : 'NineBird（Linux）'}
        desc={
          isDarwin
            ? '安装后可用扫码 / 快捷登录自动提取数据库密钥。首次安装需要输入管理员密码以修改 QQ 程序入口。'
            : '安装后可用扫码 / 快捷登录自动提取数据库密钥。Linux 只需要在 QQ 启动目录放一个 loadNineBird.js（不修改 package.json）。'
        }
      />
      <Card>
        <Row
          label="NineBird 状态"
          desc={state.kind === 'failed' && 'error' in state ? state.error : undefined}
          control={
            <span className="weq-set-row-label">
              {status.isLoading
                ? '读取中…'
                : `${STATUS_TEXT[state.kind] ?? state.kind}${state.kind === 'ninebird' ? (isDarwin ? '（NineBird 入口）' : '（loadNineBird.js）') : ''}`}
            </span>
          }
        />
        <Row
          label="安装 / 还原"
          desc={
            isDarwin
              ? 'NineBird 文件部署在 QQ 容器 Documents/weq-ninebird 下，卸载时一并删除。'
              : target
                ? `QQ 程序入口：${target}`
                : '还原会删除 loadNineBird.js；Linux 不修改 package.json。'
          }
          control={
            <span style={{ display: 'inline-flex', gap: 8 }}>
              {needsInstall ? (
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
              {!needsInstall ? (
                <button
                  type="button"
                  className="weq-set-seg-item"
                  disabled={busy}
                  onClick={() => void doUninstall()}
                  aria-label="还原原版 QQ"
                >
                  {uninstall.isPending ? <Loader2 size={14} className="is-spin" /> : null}
                  <Trash2 size={14} />
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
      {isDarwin ? (
        <p className="weq-set-desc">
          提示：如提示「not permitted」，请在 系统设置 → 隐私与安全性 → App 管理 中添加 WeQ 后重试。
        </p>
      ) : (
        <p className="weq-set-desc">
          提示：安装 / 还原需要管理员密码（sudo）。密码错误、或系统 sudo 配置了 requiretty
          时会给出对应提示。
        </p>
      )}
    </section>
  );
}
