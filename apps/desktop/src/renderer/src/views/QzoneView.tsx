/**
 * QQ 空间视图。桌面版内嵌 `<webview>`（见 EmbeddedBrowserView）；网页版嵌不了
 * （对方站点禁 iframe），改成开新标签（见 ExternalSiteView）。
 */

import type { ReactElement } from 'react';
import { Star } from 'lucide-react';
import { EmbeddedBrowserView } from './EmbeddedBrowserView';
import { ExternalSiteView } from './ExternalSiteView';
import { IS_WEB } from '../lib/target';

export function QzoneView(): ReactElement {
  if (IS_WEB) {
    return (
      <ExternalSiteView
        site="qzone"
        label="QQ 空间"
        desc="说说、相册、留言板 —— 在浏览器新标签里打开你的 QQ 空间主页。"
        icon={<Star size={28} strokeWidth={1.5} aria-hidden />}
      />
    );
  }
  return <EmbeddedBrowserView bridge={window.weq?.qzone} label="QQ 空间" />;
}
