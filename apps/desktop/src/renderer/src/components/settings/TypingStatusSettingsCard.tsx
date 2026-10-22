import { Keyboard, RotateCcw, Trash2 } from 'lucide-react';
import { useTypingStatusSettings } from '../../hooks/useTypingStatusSettings';
import { Card, Row, Toggle } from './controls';
import '../../styles/typing-status-settings.css';

export function TypingStatusSettingsCard() {
  const preferences = useTypingStatusSettings();
  const { query, disabled } = preferences;
  return (
    <div className="weq-typing-settings">
      <Card title="发送正在输入状态" icon={<Keyboard size={15} />}>
        <Row
          label="默认开启"
          control={
            <Toggle
              label="默认发送正在输入状态"
              checked={query.data?.defaultEnabled ?? false}
              disabled={disabled}
              onChange={(enabled) => void preferences.setDefault(enabled)}
            />
          }
        />
        {query.isLoading ? (
          <div className="weq-set-empty" role="status">
            加载中…
          </div>
        ) : null}
        {query.error ? (
          <div role="alert">
            {query.error.message}
            <button
              type="button"
              className="weq-set-iconbtn"
              aria-label="重试读取输入状态设置"
              title="重试读取输入状态设置"
              onClick={() => void query.refetch()}
            >
              <RotateCcw size={16} />
            </button>
          </div>
        ) : null}
        {query.data ? <h4 className="weq-typing-settings-heading">已设置特例</h4> : null}
        {query.data?.overrides.length === 0 ? <div className="weq-set-empty">暂无特例</div> : null}
        {query.data?.overrides.map((item) => (
          <Row
            key={JSON.stringify([item.accountUin, item.accountConfigId, item.uid])}
            label={item.name || item.uid}
            desc={`QQ ${item.accountUin} · ${item.accountConfigId} · ${item.uid}`}
            control={
              <div className="weq-set-btn-group">
                <Toggle
                  label={`${item.name || item.uid}的输入状态`}
                  checked={item.enabled}
                  disabled={disabled}
                  onChange={(enabled) => void preferences.setOverride(item, enabled)}
                />
                <button
                  type="button"
                  className="weq-set-iconbtn"
                  aria-label={`删除${item.name || item.uid}的输入状态特例`}
                  title="删除特例，恢复全局默认"
                  disabled={disabled}
                  onClick={() => void preferences.setOverride(item, null)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            }
          />
        ))}
      </Card>
    </div>
  );
}
