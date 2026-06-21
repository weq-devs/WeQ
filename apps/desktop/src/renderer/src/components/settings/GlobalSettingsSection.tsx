/**
 * 设置 → 全局设置.
 *
 * App-wide, account-independent items: WeQ 版本信息 + 缓存目录（可自定义）.
 *
 * Data sources:
 *   - `bootstrap.getVersionInfo` — WeQ / Electron / Chrome / Node versions
 *   - `bootstrap.getCacheDir`    — effective / override / default cache paths
 *
 * Queries here use `staleTime: 0` + `refetchOnMount: 'always'` so reopening the
 * dialog always shows fresh state (the global QueryClient otherwise keeps
 * everything fresh for 5 min and never refetches on mount).
 */

import { type ReactElement } from 'react';
import { FolderOpen, Info, RotateCcw } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { Card, Row, SectionHeader } from './controls';
import logoUrl from '@resources/brand/logo.png';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function GlobalSettingsSection(): ReactElement {
  const showError = useDialog((s) => s.showError);

  const version = trpc.bootstrap.getVersionInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const cacheDir = trpc.bootstrap.getCacheDir.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const pickCache = trpc.bootstrap.pickCacheDir.useMutation();
  const clearCache = trpc.bootstrap.clearCacheDir.useMutation();
  const cacheBusy = pickCache.isLoading || clearCache.isLoading;

  async function onPickCache(): Promise<void> {
    try {
      await pickCache.mutateAsync();
      await cacheDir.refetch();
    } catch (e) {
      showError('选择缓存目录失败', errMsg(e));
    }
  }

  async function onResetCache(): Promise<void> {
    try {
      await clearCache.mutateAsync();
      await cacheDir.refetch();
    } catch (e) {
      showError('重置缓存目录失败', errMsg(e));
    }
  }

  const v = version.data;

  return (
    <div className="weq-set">
      <SectionHeader title="全局设置" desc="与账号无关的应用级设置。" />

      {/* Version */}
      <Card>
        <div className="weq-set-hero">
          <img src={logoUrl} alt="" width={52} height={52} className="weq-set-hero-logo" />
          <div className="weq-set-hero-info">
            <span className="weq-set-hero-name">WeQ</span>
            <span className="weq-set-hero-sub weq-number">
              版本 {v?.app ?? (version.isLoading ? '…' : '未知')}
            </span>
            {v ? (
              <span className="weq-set-hero-sig">
                Electron {v.electron} · Chrome {v.chrome} · Node {v.node}
              </span>
            ) : null}
          </div>
        </div>
        <p className="weq-set-note">
          <Info size={12} strokeWidth={1.9} aria-hidden /> WeQ 通过解密 QQ
          本地数据库读取聊天记录，不注入、不依赖机器人框架。
        </p>
      </Card>

      {/* Cache directory */}
      <Card title="缓存目录">
        <Row
          label={
            <span className="weq-set-path" title={cacheDir.data?.effective}>
              <FolderOpen size={14} strokeWidth={1.8} aria-hidden />
              <span className="weq-set-path-txt">
                {cacheDir.data?.effective ?? (cacheDir.isLoading ? '读取中…' : '—')}
              </span>
            </span>
          }
          desc={
            cacheDir.data?.override
              ? '已使用自定义目录。更改后将于下次进入账号时对媒体缓存生效。'
              : '默认目录。下载的图片/视频等媒体会缓存在这里。'
          }
          control={
            <div className="weq-set-btn-group">
              <button
                type="button"
                className="weq-set-btn"
                disabled={cacheBusy}
                onClick={() => void onPickCache()}
              >
                <FolderOpen size={14} strokeWidth={1.8} aria-hidden />
                选择目录
              </button>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                disabled={cacheBusy || !cacheDir.data?.override}
                onClick={() => void onResetCache()}
              >
                <RotateCcw size={14} strokeWidth={1.8} aria-hidden />
                重置默认
              </button>
            </div>
          }
        />
      </Card>
    </div>
  );
}
