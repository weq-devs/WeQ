/**
 * 在线状态的展示辅助函数。
 *
 * misc.db 的 `online_status_kv_table.48902` 会带出 `weather` 子结构（城市 / 天气 /
 * 区县 / 「今日天气」文案），service 与 IPC 已原样透传到渲染层。这里只做纯展示
 * 拼接，方便单测覆盖，不依赖 React / trpc。
 */

export interface OnlineStatusWeather {
  weather?: string | null;
  city?: string | null;
  area?: string | null;
  weatherDesc?: string | null;
}

/** 去掉首尾空白并把连续空白压成一个空格（QQ 侧字段偶尔带全角空格）。 */
function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 把天气子结构拼成一行展示文案，例如「杭州 · 多云」。
 *
 * - 城市优先用 `city`，缺失时退回 `area`；
 * - 天气优先用 `weather`，缺失时退回 `weatherDesc`（1030「今日天气」的展示文案）；
 * - 只有城市时只显示城市；什么都没有（或全是空白）时返回 `null`，调用方保持原样。
 */
export function weatherLabel(weather: OnlineStatusWeather | null | undefined): string | null {
  if (!weather) return null;
  const city = clean(weather.city) || clean(weather.area);
  const condition = clean(weather.weather) || clean(weather.weatherDesc);
  if (city && condition) return `${city} · ${condition}`;
  return city || condition || null;
}

/**
 * 悬停提示用的完整天气信息：城市、区县、天气、展示文案能补的都补上，
 * 并去掉与 {@link weatherLabel} 重复的部分。
 */
export function weatherTitle(weather: OnlineStatusWeather | null | undefined): string | null {
  if (!weather) return null;
  const parts: string[] = [];
  const push = (value: string | null | undefined) => {
    const text = clean(value);
    if (text && !parts.includes(text)) parts.push(text);
  };
  push(weather.city);
  push(weather.area);
  push(weather.weather);
  push(weather.weatherDesc);
  return parts.length > 0 ? parts.join(' · ') : null;
}
