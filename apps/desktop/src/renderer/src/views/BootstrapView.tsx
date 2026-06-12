/**
 * Screen 1 — diagnostics + jump to account picker.
 *
 * Surfaces what the machine actually has: QQ install paths, login.db,
 * running QQ processes. No user input needed — we just show numbers and
 * a "next" button. The picker view itself decides what to do per-account.
 */

import type { ReactElement } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';

export function BootstrapView(): ReactElement {
  const install = trpc.bootstrap.describeInstall.useQuery();
  const processes = trpc.bootstrap.detectRunningProcesses.useQuery();
  trpc.bootstrap.listAccounts.useQuery(undefined, {
    enabled: !!install.data?.loginDbPath,
    retry: false,
  });
  const goTo = useViewState((s) => s.goTo);
  const preparing = install.isLoading || processes.isLoading;

  return (
    <main className="p-6 font-sans leading-relaxed">
      <h1 className="text-2xl font-bold mb-6">weQ — 环境诊断</h1>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">QQ 安装信息</h2>
        {install.isLoading && <p className="text-muted-foreground italic">正在检测…</p>}
        {install.data && (
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li><span className="font-medium">主程序 (QQ.exe):</span> {install.data.qqExePath ?? '(未找到)'}</li>
            <li><span className="font-medium">核心组件 (wrapper.node):</span> {install.data.wrapperNodePath ?? '(未找到)'}</li>
            <li><span className="font-medium">登录数据库 (login.db):</span> {install.data.loginDbPath ?? '(未找到)'}</li>
            <li className="list-none mt-2">
              <span className="font-medium">Tencent Files 数据目录:</span>
              <ul className="list-disc list-inside ml-4 mt-1 text-muted-foreground">
                {install.data.tencentFilesRoots.length === 0 && <li>(无)</li>}
                {install.data.tencentFilesRoots.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </li>
          </ul>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">正在运行的 QQ 进程</h2>
        {processes.isLoading && <p className="text-muted-foreground italic">正在检测…</p>}
        {processes.data && processes.data.length === 0 && <p className="text-muted-foreground">未发现运行中的 QQ。</p>}
        {processes.data && processes.data.length > 0 && (
          <ul className="list-disc list-inside space-y-1 text-sm">
            {processes.data.map((p) => (
              <li key={p.pid}>
                <span className="font-medium">进程 PID={p.pid}</span> —{' '}
                {p.loginInfo
                  ? `账号=${p.loginInfo.uin} 登录状态=${p.loginInfo.loggedIn ? '已登录' : '未登录'}`
                  : '(无法获取端口信息)'}
              </li>
            ))}
          </ul>
        )}
      </section>

      <button
        onClick={() => goTo('pick-account')}
        disabled={preparing}
        className="px-6 py-2 bg-primary text-primary-foreground rounded-md shadow-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
      >
        {preparing ? '正在检测…' : '去选择账号 →'}
      </button>
    </main>
  );
}
