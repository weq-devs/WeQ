/**
 * Landing screen: brand logo + the two entry buttons.
 *
 *   左 — 现有账号配置  (disabled when no saved config exists)
 *   右 — 新的开始
 */

import { type ReactElement } from 'react';
import { FolderClock, Sparkles } from 'lucide-react';
import logoUrl from '@resources/brand/logo.png';

export function HomeScreen({
  hasConfigs,
  onExisting,
  onNew,
}: {
  hasConfigs: boolean;
  onExisting: () => void;
  onNew: () => void;
}): ReactElement {
  return (
    <div className="weq-home weq-anim-fade">
      <div className="weq-home-brand">
        <img src={logoUrl} alt="WeQ" className="weq-home-logo" width={96} height={96} />
        <h1 className="weq-display weq-home-title">WeQ Desktop</h1>
        <p className="weq-home-sub">QQ NT 本地数据工具</p>
      </div>

      <div className="weq-home-actions">
        <button
          type="button"
          className="weq-entry-card"
          onClick={onExisting}
          disabled={!hasConfigs}
          title={hasConfigs ? '' : '暂无保存的账号配置'}
        >
          <span className="weq-entry-icon">
            <FolderClock size={22} strokeWidth={1.7} aria-hidden />
          </span>
          <span className="weq-entry-text">
            <span className="weq-entry-title">现有账号配置</span>
            <span className="weq-entry-desc">直接打开已确认过的本地密钥</span>
          </span>
        </button>

        <button type="button" className="weq-entry-card is-primary" onClick={onNew}>
          <span className="weq-entry-icon">
            <Sparkles size={22} strokeWidth={1.7} aria-hidden />
          </span>
          <span className="weq-entry-text">
            <span className="weq-entry-title">新的开始</span>
            <span className="weq-entry-desc">检测账号并获取数据库密钥</span>
          </span>
        </button>
      </div>
    </div>
  );
}
