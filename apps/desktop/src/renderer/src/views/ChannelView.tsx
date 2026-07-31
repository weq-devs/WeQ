/**
 * QQ 频道视图。桌面版内嵌 `<webview>`（见 EmbeddedBrowserView）；网页版嵌不了
 * （对方站点禁 iframe），改成开新标签（见 ExternalSiteView）。
 */

import type { ReactElement } from 'react';
import { Hash } from 'lucide-react';
import { EmbeddedBrowserView } from './EmbeddedBrowserView';
import { ExternalSiteView } from './ExternalSiteView';
import { IS_WEB } from '../lib/target';

export function ChannelView(): ReactElement {
  if (IS_WEB) {
    return (
      <ExternalSiteView
        site="channel"
        label="QQ 频道"
        desc="子频道、话题、动态 —— 在浏览器新标签里打开 QQ 频道。"
        icon={<Hash size={28} strokeWidth={1.5} aria-hidden />}
      />
    );
  }
  return <EmbeddedBrowserView bridge={window.weq?.channel} label="QQ 频道" />;
}
