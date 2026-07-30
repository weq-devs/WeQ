/**
 * QQ 动态分享卡 (elementType=26 / QQ_DYNAMIC, QQ 内部名 TOFU).
 *
 * A share card for a QQ-zone dynamic (说说/动态). Unlike an ark card there is no
 * JSON payload — every field sits directly on the element:
 *   - dynamicDesc.mainDesc / .subDesc — primary + secondary title
 *   - dynamicDesc2                    — a secondary block, used when the first is empty
 *   - dynamicCoverUrl                 — cover thumbnail (external CDN)
 *   - dynamicZoneLogoUrl              — QQ 空间 logo for the footer
 *
 * Layout reuses the ark card's compact classes (`weq-ark-*`) so it sits next to
 * real ark cards without a second visual language. Both images are external
 * URLs, so each hides itself on load failure rather than leaving a broken frame.
 */

import { useState } from 'react';

interface DynamicDesc {
  mainDesc?: string;
  subDesc?: string;
}

export function QqDynamic({
  desc,
  desc2,
  coverUrl,
  zoneLogoUrl,
}: {
  desc?: DynamicDesc;
  desc2?: DynamicDesc;
  coverUrl?: string;
  zoneLogoUrl?: string;
}) {
  const [coverBroken, setCoverBroken] = useState(false);
  const [logoBroken, setLogoBroken] = useState(false);

  // Prefer the primary description block; fall back to the secondary one when
  // QQ left it empty (observed on some reposts).
  const title = desc?.mainDesc?.trim() || desc2?.mainDesc?.trim() || 'QQ动态';
  const subtitle = desc?.subDesc?.trim() || desc2?.subDesc?.trim() || '';

  return (
    <div className="weq-ark-container" style={{ cursor: 'default' }}>
      <div className="weq-ark-content">
        <div className="weq-ark-body-compact">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="weq-ark-title">{title}</div>
            {subtitle ? <div className="weq-ark-desc">{subtitle}</div> : null}
          </div>
          {coverUrl && !coverBroken ? (
            <img
              className="weq-ark-preview-small"
              src={coverUrl}
              alt=""
              loading="lazy"
              onError={() => setCoverBroken(true)}
            />
          ) : null}
        </div>
      </div>
      <div className="weq-ark-footer">
        {zoneLogoUrl && !logoBroken ? (
          <img
            className="weq-ark-footer-icon"
            src={zoneLogoUrl}
            alt=""
            loading="lazy"
            onError={() => setLogoBroken(true)}
          />
        ) : null}
        <span>QQ空间</span>
      </div>
    </div>
  );
}
