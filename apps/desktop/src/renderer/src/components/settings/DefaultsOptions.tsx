import type { WeqDefaultsChoice, WeqDefaultsPath, WeqDefaultsConnection } from '@weq/service';

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
        {info.hasApi ? (
          <label className="weq-backup-check">
            <input
              type="checkbox"
              checked={Boolean(choice.clearApi)}
              onChange={(event) => onChange({ ...choice, clearApi: event.target.checked })}
            />
            <span>同时清除 API 配置与凭据（模型、TTS、MCP、OneBot、外部 rkey、SSE）</span>
          </label>
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
        {info.connections.length ? (
          <section>
            <h4>连接与自启</h4>
            {info.connections.map((item) => (
              <label className="weq-defaults-row" key={item.id}>
                <span>
                  {item.label}
                  <small>{item.value}</small>
                </span>
                <select
                  aria-label={item.label}
                  value={choice.resetConnections?.includes(item.id) ? 'reset' : 'keep'}
                  onChange={(event) =>
                    onChange({
                      ...choice,
                      resetConnections:
                        event.target.value === 'reset'
                          ? [...(choice.resetConnections ?? []), item.id]
                          : choice.resetConnections?.filter((id) => id !== item.id),
                    })
                  }
                >
                  <option value="keep">保留当前</option>
                  <option value="reset">恢复默认</option>
                </select>
              </label>
            ))}
            {choice.resetConnections?.some((id) =>
              ['webEnabled', 'remoteEnabled', 'tailscaleEnabled'].includes(id),
            ) ? (
              <p>恢复服务开关会断开对应的浏览器或手机连接。</p>
            ) : null}
          </section>
        ) : null}
      </fieldset>
      {selected.length ? <p>另外恢复或清除：{selected.join('、')}。</p> : null}
    </div>
  );
}
