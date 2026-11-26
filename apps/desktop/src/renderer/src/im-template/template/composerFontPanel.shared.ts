import { useEffect, useState } from 'react';
import { useDevelopmentDressTools } from '../../hooks/useDevelopmentDressTools';
import { fontFaces } from '../../lib/fontFaces';
import { messageFontFamily } from '../../lib/msgDecorationStyle';
import { dressFontUrl } from '../../lib/resourceUrl';
import { trpc } from '../../trpc/client';

export function useComposerFont(available: boolean, open: boolean) {
  const development = useDevelopmentDressTools();
  const enabled = available && open;
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    select: (data) => ({
      preferences: data.composerFont,
      defaultFont: data.defaultMessageFont,
    }),
  });
  const accountDefault = settings.data?.defaultFont !== 'plain';
  const dress = trpc.account.dressup.getState.useQuery(undefined, {
    enabled: enabled && (development || accountDefault),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const state = dress.data;
  const manifest = state?.manifest;
  const preferences = settings.data?.preferences;
  const choice = preferences?.choice;
  const selectedId = choice === 'legacy-dress' ? manifest?.activeFont : choice;
  const own = accountDefault ? state?.own : undefined;
  const fontId = own?.fontId ?? 0;
  const installed = fontId ? manifest?.fonts.find((font) => font.itemId === fontId) : undefined;
  const preview = own?.fontPreviewUrl || installed?.previewUrl;
  const resolved = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { fontId, bubbleId: 0, widgetId: 0 },
    { enabled: enabled && !!fontId && !preview && !installed, staleTime: Infinity, retry: false },
  );
  return {
    development,
    fonts: manifest?.fonts,
    preferences,
    defaultPreview: { preview, localFont: installed ?? resolved.data?.font ?? undefined },
    selected:
      development &&
      typeof selectedId === 'number' &&
      selectedId > 0 &&
      selectedId <= 0xffff &&
      manifest?.fonts.some((font) => font.itemId === selectedId)
        ? selectedId
        : 'default',
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
