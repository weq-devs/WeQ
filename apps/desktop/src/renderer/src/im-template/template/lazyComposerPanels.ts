import { lazyPanel } from '../../lib/lazyPanel';
import type { ComponentProps } from 'react';

export const GiftMallPanel = lazyPanel<
  ComponentProps<typeof import('../../components/gift/GiftMallPanel').GiftMallPanel>
>(() =>
  import('../../components/gift/GiftMallPanel').then((module) => ({
    default: module.GiftMallPanel,
  })),
);
export const GroupGiftPanel = lazyPanel<
  ComponentProps<typeof import('../../components/gift/GroupGiftPanel').GroupGiftPanel>
>(() =>
  import('../../components/gift/GroupGiftPanel').then((module) => ({
    default: module.GroupGiftPanel,
  })),
);
export const ArkPanel = lazyPanel<ComponentProps<typeof import('./arkPanel').ArkPanel>>(() =>
  import('./arkPanel').then((module) => ({ default: module.ArkPanel })),
);
export const RedPacketPanel = lazyPanel<
  ComponentProps<typeof import('./redPacketPanel').RedPacketPanel>
>(() => import('./redPacketPanel').then((module) => ({ default: module.RedPacketPanel })));
export const LocationCardPanel = lazyPanel<
  ComponentProps<typeof import('./locationCardPanel').LocationCardPanel>
>(() => import('./locationCardPanel').then((module) => ({ default: module.LocationCardPanel })));
export const LocationSharePanel = lazyPanel<
  ComponentProps<typeof import('./locationSharePanel').LocationSharePanel>
>(() => import('./locationSharePanel').then((module) => ({ default: module.LocationSharePanel })));
