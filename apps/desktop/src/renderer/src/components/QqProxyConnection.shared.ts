import type { OnlineAccess } from '../lib/restrictedMode';

export const QQ_PROXY_CONNECTING = '正在确认 QQ 代理连接';
export const QQ_PROXY_WAITING = '正在等待 QQ 代理连接';

export function isQqProxyWaiting(
  proxy:
    | {
        accountUin: string | null;
        accountConfigId: string | null;
        enabled: boolean;
        running: boolean;
        connected: boolean;
        connecting: boolean;
      }
    | undefined,
  access: OnlineAccess | undefined,
  uin: string | null,
): boolean {
  const source = access?.source;
  return (
    proxy?.enabled === true &&
    proxy.running &&
    !proxy.connected &&
    !proxy.connecting &&
    uin !== null &&
    proxy.accountUin === uin &&
    access?.qqOnline === true &&
    (!source ||
      (source.expectedAccountUin === uin &&
        source.expectedAccountConfigId === proxy.accountConfigId))
  );
}

export function qqProxySetupGuide(port?: number): string {
  const portHint = port === undefined ? 'WeQ 显示的代理端口' : String(port);
  return `打开 QQ 登录窗口右上角的菜单，进入「网络设置」。将代理类型选为 HTTP，地址填 127.0.0.1，端口填 ${portHint}。确认设置后登录 QQ。`;
}
