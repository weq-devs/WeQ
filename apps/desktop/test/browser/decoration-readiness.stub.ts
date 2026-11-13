import { createContext, useEffect, useState } from 'react';

export const MsgDecorationEnabledContext = createContext({
  bubble: true,
  font: true,
  widget: true,
});
export const bubble = {
  itemId: 21009,
  slice: { left: 4, right: 4, top: 4, bottom: 4 },
  imageSize: { w: 40, h: 40 },
  textColor: '#516196',
  localFile: 'fixture.png',
};
const font = { deriveVersion: 1, fx: null };
export const trpc = {
  account: {
    dressup: {
      resolveMsgDecoration: {
        useQuery: (ids: { bubbleId: number; fontId: number }, options: { enabled: boolean }) => {
          const [resolved, setResolved] = useState<typeof bubble | null>();
          useEffect(() => {
            if (!ids.bubbleId || !options.enabled) return;
            const controller = new AbortController();
            void fetch('/fixtures/bubble-skin', { signal: controller.signal })
              .then((response) => response.json())
              .then(setResolved)
              .catch(() => {});
            return () => controller.abort();
          }, [ids.bubbleId, options.enabled]);
          return {
            data: { bubble: ids.bubbleId ? resolved : null, font: ids.fontId ? font : null },
          };
        },
      },
    },
  },
};
