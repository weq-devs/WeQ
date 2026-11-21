import { useState } from 'react';
import type { UpdatePhase } from '../../src/renderer/src/hooks/useAppUpdate';

export function useAppUpdate() {
  const downloadFixture = new URLSearchParams(window.location.search).has('download');
  const [includePrerelease, setPrerelease] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>(downloadFixture ? 'downloading' : 'idle');
  const [foreground, setForeground] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const paused = phase === 'paused';
  return {
    intervalMinutes,
    changingInterval: false,
    intervalReady: true,
    setIntervalMinutes: async (minutes: number) => {
      setIntervalMinutes(minutes);
      return minutes;
    },
    includePrerelease,
    changingPrerelease: false,
    setPrerelease: async (enabled: boolean) => {
      setPrerelease(enabled);
      setPhase('idle');
    },
    phase,
    current: '2.6.1',
    latest: downloadFixture ? '2.7.5' : null,
    progress: downloadFixture
      ? { percent: 40, transferred: 4 * 1048576, total: 10 * 1048576, bytesPerSecond: 1048576 }
      : null,
    downloadTask: downloadFixture
      ? {
          id: 'synthetic',
          foreground,
          status: paused ? 'paused' : 'running',
          statusLabel: paused ? '已暂停' : undefined,
          actions: [{ id: paused ? 'continue' : 'pause', label: paused ? '继续下载' : '暂停下载' }],
        }
      : null,
    controllingDownload: false,
    controlDownload: async (action: string) => {
      if (action === 'background') setForeground(false);
      else if (action === 'pause') setPhase('paused');
      else if (action === 'continue') setPhase('downloading');
    },
    mirrorName: '',
    mirrorCount: null,
    isDev: false,
    isManaged: false,
    check: async () => {
      setPhase('uptodate');
    },
    download: async () => {},
    install: async () => {},
  };
}
