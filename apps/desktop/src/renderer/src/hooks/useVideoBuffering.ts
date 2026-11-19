import { useState, type VideoHTMLAttributes } from 'react';

/** 使用播放器的等待状态；时间轴的缓冲比例不是文件字节进度。 */
export function useVideoBuffering(key: string, active: boolean) {
  const [state, setState] = useState({ key: '', waiting: false });
  const start = () => {
    if (active) setState({ key, waiting: true });
  };
  const stop = () =>
    setState((old) => (old.key === key && old.waiting ? { key, waiting: false } : old));
  const events = {
    onLoadStart: start,
    onWaiting: start,
    onPlaying: stop,
    onCanPlay: stop,
    onPause: stop,
    onEnded: stop,
    onError: stop,
  } satisfies VideoHTMLAttributes<HTMLVideoElement>;
  return { events, waiting: active && state.key === key && state.waiting };
}
