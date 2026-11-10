import { createContext } from 'react';

export const MsgDecorationEnabledContext = createContext({
  bubble: true,
  font: true,
  widget: true,
});
const bubble = {
  itemId: 21009,
  slice: { left: 4, right: 4, top: 4, bottom: 4 },
  imageSize: { w: 40, h: 40 },
  textColor: '#516196',
};
const font = { deriveVersion: 1, fx: null };
export const trpc = {
  account: {
    dressup: {
      resolveMsgDecoration: {
        useQuery: (ids: { bubbleId: number; fontId: number }) => ({
          data: { bubble: ids.bubbleId ? bubble : null, font: ids.fontId ? font : null },
        }),
      },
    },
  },
};
