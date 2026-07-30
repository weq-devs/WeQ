/**
 * 位置共享 (elementType=28 / SHARE_LOCATION).
 *
 * QQ stores nothing but a text label here — no coordinates, no place name, no
 * duration, no participants (verified across every occurrence in the local DB:
 * the element carries only elementId/elementType/subType and tag 52152). The
 * live location stream is realtime-only and never lands in nt_msg.db, so a real
 * map thumbnail is impossible; we render the ark location card's fake-map
 * texture (which exists as its static-image fallback) with a pin instead.
 *
 * Styles are reused verbatim from ArkLocation (`weq-ark-*`) so the bubble looks
 * native next to a real 位置分享 ark card.
 */

import { MapPin } from 'lucide-react';

export function QqShareLocation({ text }: { text?: string }) {
  const label = text?.trim() || '发起了位置共享';

  return (
    <div className="weq-ark-container" style={{ cursor: 'default' }}>
      <div className="weq-ark-content">
        <div className="weq-ark-title">{label}</div>
        <div className="weq-ark-desc" style={{ color: '#8c8c8c', marginBottom: 8 }}>
          实时位置不会保存到本地
        </div>
        <div className="weq-ark-map-view">
          <MapPin className="weq-ark-map-pin" size={28} strokeWidth={2.2} />
          <span className="weq-ark-map-name">位置共享</span>
        </div>
      </div>
    </div>
  );
}
