import type { WeqDefaultsChoice, WeqDefaultsPath, WeqDefaultsConnection } from '@weq/service';
import { Row, Toggle } from './controls';

export const DEFAULTS_DESCRIPTION =
  '恢复通用设置、界面外观与布局、联系人分组与排序、消息显示范围、搜索与日历显示偏好、默认进入账号、导出预设、应用锁偏好及所有账号的功能设置。';
export interface DefaultsInfo {
  hasApi: boolean;
  paths: { id: WeqDefaultsPath; label: string; value: string }[];
  connections: { id: WeqDefaultsConnection; label: string; value: string }[];
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
  const selected = [
    ...(choice.clearApi ? ['API 配置与凭据'] : []),
    ...info.paths.filter((item) => choice.resetPaths?.includes(item.id)).map((item) => item.label),
    ...info.connections
      .filter((item) => choice.resetConnections?.includes(item.id))
      .map((item) => item.label),
  ];
  return (
    <div className="weq-defaults-options">
      <p>{DEFAULTS_DESCRIPTION}</p>
      <p>
        账号功能设置包括防撤回、群关键词提醒、意图感知、装扮选择、邮箱提醒、数据库容错和年度报告偏好。
      </p>
      <fieldset disabled={disabled}>
        <div className="weq-defaults-toggles">
          <Row
            label="API 配置"
            desc="清除模型、TTS、MCP、OneBot、外部 rkey、SSE 的配置与凭据。"
            control={
              <Toggle
                label="API 配置"
                checked={Boolean(choice.clearApi)}
                disabled={disabled || !info.hasApi}
                onChange={(checked) => onChange({ ...choice, clearApi: checked })}
              />
            }
          />
          <Row
            label="WeQ 服务"
            desc={
              info.connections.length
                ? `恢复${info.connections.map((item) => item.label).join('、')}的默认设置。`
                : '包括 Web 服务、远程服务与连接模式、Tailscale 网络连接、系统登录自启、启动时显示窗口、Web 服务自动启动和 WeQ 助手服务；当前均为默认设置。'
            }
            control={
              <Toggle
                label="WeQ 服务"
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
        {info.paths.length ? (
          <section>
            <h4>自定义目录</h4>
            {info.paths.map((item) => (
              <label className="weq-defaults-row" key={item.id}>
                <span>
                  {item.label}
                  <small>{item.value}</small>
                </span>
                <select
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
                </select>
              </label>
            ))}
            {choice.resetPaths?.length ? (
              <p>所选目录恢复默认路径，仅更改路径设置，不迁移文件。</p>
            ) : null}
          </section>
        ) : null}
      </fieldset>
      {selected.length ? <p>另外恢复或清除：{selected.join('、')}。</p> : null}
    </div>
  );
}
