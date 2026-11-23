import { X } from 'lucide-react';
import type { ComponentProps, Ref } from 'react';
import { PanelLoading } from '../../components/LoadingIndicator';
import { OverlayLayer } from '../../components/OverlayLayer';
import { lazyPanel } from '../../lib/lazyPanel';
import '../../styles/gift-mall.css';

function GiftLoading({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <OverlayLayer presentation="modal" className="weq-gift-layer" onClose={onClose}>
      <div className="weq-gift-dialog" role="dialog" aria-label={title} aria-modal="true">
        <header className="weq-gift-head">
          <strong className="weq-gift-title">{title}</strong>
          <button
            className="weq-gift-close"
            type="button"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <PanelLoading startup={false} />
      </div>
    </OverlayLayer>
  );
}

function ComposerPanelLoading({
  title,
  className,
  panelRef,
  onClose,
}: {
  title: string;
  className: string;
  panelRef?: Ref<HTMLDivElement>;
  onClose?: () => void;
}) {
  return (
    <div
      className={`${className} weq-composer-panel-loading`}
      ref={panelRef}
      role="dialog"
      aria-label={title}
    >
      <header className="ark-head">
        <strong>{title}</strong>
        {onClose ? (
          <button
            className="ark-close"
            type="button"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        ) : null}
      </header>
      <PanelLoading startup={false} />
    </div>
  );
}

export const GiftMallPanel = lazyPanel<
  ComponentProps<typeof import('../../components/gift/GiftMallPanel').GiftMallPanel>
>(
  () =>
    import('../../components/gift/GiftMallPanel').then((module) => ({
      default: module.GiftMallPanel,
    })),
  ({ onClose }) => <GiftLoading title="礼物" onClose={onClose} />,
);
export const GroupGiftPanel = lazyPanel<
  ComponentProps<typeof import('../../components/gift/GroupGiftPanel').GroupGiftPanel>
>(
  () =>
    import('../../components/gift/GroupGiftPanel').then((module) => ({
      default: module.GroupGiftPanel,
    })),
  ({ onClose }) => <GiftLoading title="群礼物" onClose={onClose} />,
);
export const ArkPanel = lazyPanel<ComponentProps<typeof import('./arkPanel').ArkPanel>>(
  () => import('./arkPanel').then((module) => ({ default: module.ArkPanel })),
  ({ panelRef, onClose }) => (
    <ComposerPanelLoading
      title="发送 Ark 卡片"
      className="ark-panel"
      panelRef={panelRef}
      onClose={onClose}
    />
  ),
);
export const RedPacketPanel = lazyPanel<
  ComponentProps<typeof import('./redPacketPanel').RedPacketPanel>
>(
  () => import('./redPacketPanel').then((module) => ({ default: module.RedPacketPanel })),
  ({ panelRef, onClose }) => (
    <ComposerPanelLoading
      title="发红包"
      className="redpacket-panel"
      panelRef={panelRef}
      onClose={onClose}
    />
  ),
);
export const LocationCardPanel = lazyPanel<
  ComponentProps<typeof import('./locationCardPanel').LocationCardPanel>
>(
  () => import('./locationCardPanel').then((module) => ({ default: module.LocationCardPanel })),
  ({ panelRef, onClose }) => (
    <ComposerPanelLoading
      title="发送位置"
      className="ark-panel location-card-panel"
      panelRef={panelRef}
      onClose={onClose}
    />
  ),
);
export const LocationSharePanel = lazyPanel<
  ComponentProps<typeof import('./locationSharePanel').LocationSharePanel>
>(
  () => import('./locationSharePanel').then((module) => ({ default: module.LocationSharePanel })),
  ({ panelRef, onClose }) => (
    <ComposerPanelLoading
      title="位置共享"
      className="lbs-panel"
      panelRef={panelRef}
      onClose={onClose}
    />
  ),
);
