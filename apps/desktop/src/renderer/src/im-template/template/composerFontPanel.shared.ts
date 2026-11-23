import { useEffect, useState } from 'react';
import { useDevelopmentDressTools } from '../../hooks/useDevelopmentDressTools';
import { fontFaces } from '../../lib/fontFaces';
import { messageFontFamily } from '../../lib/msgDecorationStyle';
import { dressFontUrl } from '../../lib/resourceUrl';
import { trpc } from '../../trpc/client';

export function useComposerFont(available: boolean, open: boolean) {
  const development = useDevelopmentDressTools();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: available,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    select: (data) => ({
      preferences: data.composerFont,
      showMessageFont: data.showMessageFont,
    }),
  });
  const preferences = settings.data?.preferences;
  const warmSendFont = preferences?.send && settings.data?.showMessageFont !== false;
  const dress = trpc.account.dressup.getState.useQuery(undefined, {
    enabled: available && (open || !!preferences?.preview || !!warmSendFont),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const state = dress.data;
  const manifest = state?.manifest;
  const qqFont = state?.own.fontId ?? 0;
  const choice = preferences?.choice;
  const customId = development && typeof choice === 'number' ? choice : 0;
  const legacyId = development && choice === 'legacy-dress' ? (manifest?.activeFont ?? 0) : 0;
  const selected: 'plain' | 'qq' | number =
    customId || legacyId || (choice === 'qq' && qqFont ? 'qq' : 'plain');
  const currentId = selected === 'qq' ? qqFont : typeof selected === 'number' ? selected : 0;
  const fontId = available && (preferences?.preview || warmSendFont) ? currentId : 0;
  const installed = fontId ? manifest?.fonts.find((font) => font.itemId === fontId) : undefined;
  const resolved = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { fontId, bubbleId: 0, widgetId: 0 },
    { enabled: !!fontId && !installed, staleTime: Infinity, retry: false },
  );
  const derived = resolved.data?.font ?? installed;
  const family = useFontFamily(derived ? fontId : 0, derived?.deriveVersion);

  return {
    development,
    state,
    preferences,
    selected,
    family: preferences?.preview ? family : '',
  };
}

export function useFontFamily(itemId: number, version = 0): string {
  const family = itemId ? messageFontFamily(itemId, version) : '';
  const [loaded, setLoaded] = useState('');
  useEffect(() => {
    if (!family) return;
    let active = true;
    const lease = fontFaces.acquire(family, dressFontUrl(itemId, version));
    void lease.ready.then((ready) => {
      if (active) setLoaded(ready ? family : '');
    });
    return () => {
      active = false;
      lease.release();
    };
  }, [family, itemId, version]);
  return family && family === loaded ? family : '';
}
