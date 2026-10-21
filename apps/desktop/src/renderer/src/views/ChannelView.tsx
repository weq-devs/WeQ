/**
 * QQ 频道视图。桌面版内嵌 `<webview>`（见 EmbeddedBrowserView）；网页版嵌不了
 * （对方站点禁 iframe），改成开新标签（见 ExternalSiteView）。
 */

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { Hash, MessagesSquare } from 'lucide-react';
import { GuildDirectDialog, type GuildSearchTarget } from '../components/GuildDirectDialog';
import type { User } from '../im-template/template/types';
import type { MessageRenderer } from '../im-template/template/messageRenderers';
import { EmbeddedBrowserView } from './EmbeddedBrowserView';
import { ExternalSiteView } from './ExternalSiteView';
import { IS_WEB } from '../lib/target';
import '../styles/channel.css';

export function ChannelView({
  selfUser,
  renderers,
  initialDirectOpen = false,
  sidebarWidth = 362,
  searchTarget,
  onActiveNodeChange,
}: {
  selfUser: User;
  renderers?: MessageRenderer[];
  initialDirectOpen?: boolean;
  sidebarWidth?: number;
  searchTarget?: GuildSearchTarget | null;
  /** 当前打开的频道私聊 nodeId（浮动工具按当前位置导出）。 */
  onActiveNodeChange?: (nodeId: string | null) => void;
}): ReactElement {
  const [directOpen, setDirectOpen] = useState(initialDirectOpen);
  const [visited, setVisited] = useState(initialDirectOpen);
  useEffect(() => {
    if (searchTarget) {
      setVisited(true);
      setDirectOpen(true);
    }
  }, [searchTarget]);
  return (
    <section
      className="weq-channel-workspace"
      aria-label="QQ 频道"
      style={{ '--weq-channel-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="weq-channel-browser" hidden={directOpen}>
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
          onClick={() => {
            setVisited(true);
            setDirectOpen(true);
          }}
        >
          <MessagesSquare size={22} aria-hidden />
        </button>
      </div>
      {visited ? (
        <div className="weq-channel-direct-panel" hidden={!directOpen}>
          <GuildDirectDialog
            open
            embedded
            selfUser={selfUser}
            renderers={renderers}
            searchTarget={searchTarget}
            onActiveSessionChange={onActiveNodeChange}
            onClose={() => setDirectOpen(false)}
          />
        </div>
      ) : null}
    </section>
  );
}
