import * as timeFormat from '@weq/time';

/**
 * 录音状态条 / 录音结果卡片。
 *
 * 录音中：红点 + 时长 + 当前模式，贴在波形与操作栏之间（不抢舞台）。
 * 录音结束：变成一张卡片，可以播放、打开所在目录、关掉窗口。
 *
 * 为什么结束后**不自动关窗**：录音是用户主动要留下的东西，窗口一闪而过等于让人
 * 去文件管理器里翻。没录音时仍按原来的行为 1.6 秒后自动关。
 */

export function formatDuration(seconds: number): string {
  return timeFormat.formatDuration(Math.max(0, seconds), 'call');
}
