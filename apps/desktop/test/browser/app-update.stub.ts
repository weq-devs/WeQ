import { useState } from 'react';
import type { UpdatePhase } from '../../src/renderer/src/hooks/useAppUpdate';

export function useAppUpdate() {
  const [includePrerelease, setPrerelease] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  return {
    includePrerelease,
    changingPrerelease: false,
    setPrerelease: async (enabled: boolean) => {
      setPrerelease(enabled);
      setPhase('idle');
    },
    phase,
    current: '2.6.1',
    latest: null,
    progress: null,
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
