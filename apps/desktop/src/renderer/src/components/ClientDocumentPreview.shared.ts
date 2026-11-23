import { accountGatewayUnscopedPath } from '../lib/accountGateway';
import { create } from 'zustand';
import { IS_WEB } from '../lib/target.shared';
import '../styles/client-document.css';

export const useClientDocument = create<{ document: { url: string; title: string } | null }>(
  () => ({
    document: null,
  }),
);

/** 浏览器结果必须由当前客户端实际呈现，不能把服务端空操作当作已打开。 */
export function presentClientDocument(result: unknown, title: string): void {
  if (!IS_WEB || !result || typeof result !== 'object') return;
  const value = result as { openUrl?: unknown; downloadUrl?: unknown };
  if (typeof value.openUrl === 'string') {
    const url = new URL(value.openUrl, location.href);
    if (
      url.origin !== location.origin ||
      !accountGatewayUnscopedPath(url.pathname).startsWith('/_download/')
    )
      throw new Error('报告地址不可用');
    useClientDocument.setState({ document: { url: url.href, title } });
  } else if (typeof value.downloadUrl === 'string') {
    const link = document.createElement('a');
    link.href = value.downloadUrl;
    link.download = '';
    link.click();
  }
}
