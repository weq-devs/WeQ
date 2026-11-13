/**
 * QQ 频道视图。桌面版内嵌 `<webview>`（见 EmbeddedBrowserView）；网页版嵌不了
 * （对方站点禁 iframe），改成开新标签（见 ExternalSiteView）。
 */

import { useEffect, type ReactElement } from 'react';
import { Hash, MessagesSquare } from 'lucide-react';
import { EmbeddedBrowserView } from './EmbeddedBrowserView';
import { ExternalSiteView } from './ExternalSiteView';
import { IS_WEB } from '../lib/target';
import '../styles/channel.css';

export function ChannelView({
  initialDirectOpen = false,
  onOpenDirect,
}: {
  initialDirectOpen?: boolean;
  onOpenDirect: () => void;
}): ReactElement {
  useEffect(() => {
    if (initialDirectOpen) onOpenDirect();
  }, [initialDirectOpen, onOpenDirect]);
  return (
    <section className="weq-channel-workspace" aria-label="QQ 频道">
      <div className="weq-channel-browser">
        {IS_WEB ? (
          <ExternalSiteView
            site="channel"
            label="QQ 频道"
            desc="子频道、话题、动态 —— 在浏览器新标签里打开 QQ 频道。"
            icon={<Hash size={28} strokeWidth={1.5} aria-hidden />}
          />
        ) : (
          <EmbeddedBrowserView bridge={window.weq?.channel} label="QQ 频道" />
        )}
        <button
          type="button"
          className="weq-channel-direct-trigger"
          title="频道私聊"
          aria-label="频道私聊"
          onClick={onOpenDirect}
        >
          <MessagesSquare size={22} aria-hidden />
        </button>
      </div>
    </section>
  );
}
