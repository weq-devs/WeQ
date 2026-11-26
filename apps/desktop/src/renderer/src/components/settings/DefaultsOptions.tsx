import { FormSelect } from '../FormSelect';
import type { WeqDefaultsChoice, WeqDefaultsPath, WeqDefaultsConnection } from '@weq/service';
import { Row, Toggle } from './controls';
import { DEFAULTS_DESCRIPTION } from './DefaultsOptions.shared';
import type { LogPrunePreview } from '../../../../shared/settings_reset';

export interface DefaultsInfo {
  hasApi: boolean;
  paths: { id: WeqDefaultsPath; label: string; value: string }[];
  connections: { id: WeqDefaultsConnection; label: string; value: string }[];
  logPrune: LogPrunePreview | null;
}
export function DefaultsOptions({
  info,
  choice,
  onChange,
  disabled,
}: {
  info: DefaultsInfo;
  choice: WeqDefaultsChoice;
  onChange: (choice: WeqDefaultsChoice) => void;
  disabled: boolean;
}) {
  const resetServices =
    info.connections.length > 0 &&
    info.connections.every((item) => choice.resetConnections?.includes(item.id));
  return (
    <div className="weq-defaults-options">
      <p>{DEFAULTS_DESCRIPTION}</p>
      <p>
        恢复 WeQ 助手的通用设置，保留会话和会话级模型选择。默认保留 API 配置与凭据、WeQ
        服务配置和自定义目录；不删除账号配置、聊天记录或克隆体数据。
      </p>
      <fieldset disabled={disabled}>
        <div className="weq-defaults-toggles">
          <Row
            label="清除 API 配置"
            desc="清除模型、TTS、MCP、助手的外部 MCP 服务器、OneBot、外部 rKey 和 SSE 的配置与凭据。"
            control={
              <Toggle
                label="清除 API 配置"
                checked={Boolean(choice.clearApi)}
                disabled={disabled || !info.hasApi}
                onChange={(checked) => onChange({ ...choice, clearApi: checked })}
              />
            }
          />
          <Row
            label="清除 WeQ 服务配置"
            desc={
              info.connections.length
                ? `恢复${info.connections.map((item) => item.label).join('、')}的默认设置。`
                : '当前可恢复的服务配置均为默认设置。'
            }
            control={
              <Toggle
                label="清除 WeQ 服务配置"
                checked={resetServices}
                disabled={disabled || !info.connections.length}
                onChange={(checked) =>
                  onChange({
                    ...choice,
                    resetConnections: checked ? info.connections.map((item) => item.id) : [],
                  })
                }
              />
            }
          />
        </div>
        {choice.resetConnections?.some((id) =>
          ['webEnabled', 'remoteEnabled', 'tailscaleEnabled'].includes(id),
        ) ? (
          <p>恢复服务开关会断开对应的浏览器或手机连接。</p>
        ) : null}
        {choice.resetConnections?.includes('qqProxyEnabled') ? (
          <p>停用 QQ 代理前，请先在 QQ 的「网络设置」中恢复直连。</p>
        ) : null}
        {info.paths.length ? (
          <section aria-label="自定义目录">
            <h4>自定义目录</h4>
            {info.paths.map((item) => (
              <label className="weq-set-row weq-defaults-row" key={item.id}>
                <span className="weq-set-row-main">
                  <span className="weq-set-row-label">{item.label}</span>
                  <small className="weq-set-row-desc">{item.value}</small>
                </span>
                <FormSelect
                  className="weq-set-input"
                  aria-label={item.label}
                  value={choice.resetPaths?.includes(item.id) ? 'reset' : 'keep'}
                  onChange={(event) =>
                    onChange({
                      ...choice,
                      resetPaths:
                        event.target.value === 'reset'
                          ? [...(choice.resetPaths ?? []), item.id]
                          : choice.resetPaths?.filter((id) => id !== item.id),
                    })
                  }
                >
                  <option value="keep">保留当前</option>
                  <option value="reset">恢复默认</option>
                </FormSelect>
              </label>
            ))}
            {choice.resetPaths?.length ? (
              <p>仅更改所选目录的路径设置，不迁移或删除已有文件。</p>
            ) : null}
          </section>
        ) : null}
      </fieldset>
    </div>
  );
}
