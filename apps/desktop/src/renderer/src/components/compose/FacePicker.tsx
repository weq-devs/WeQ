/**
 * Face picker — lists every built-in QQ face from emoji.db (base_sys_emoji_table
 * via account.getSystemFaces), grouped by source, ~15 per row. Clicking a face
 * emits the faceId + display text to author a `face` element.
 *
 * The authored faceId is the Unicode code point for emoji-type faces (so
 * FaceEmoji renders the glyph) and the plain id otherwise (renders the APNG).
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Search } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { FaceEmoji } from '../FaceEmoji';

const GROUP_LABEL: Record<number, string> = {
  1: '经典表情',
  3: '动态表情',
  2: 'Emoji',
};
const GROUP_ORDER = [1, 3, 2];

export interface FaceChoice {
  faceId: number;
  faceText: string;
}

export function FacePicker({ onPick }: { onPick: (choice: FaceChoice) => void }): ReactElement {
  const query = trpc.account.getSystemFaces.useQuery(undefined, { staleTime: Infinity });
  const [kw, setKw] = useState('');

  const groups = useMemo(() => {
    const faces = (query.data ?? [])
      .map((f) => ({
        faceId: f.unicodeId && f.unicodeId > 0 ? f.unicodeId : f.id,
        faceText: f.desc,
        emojiType: f.emojiType || 1,
      }))
      // De-dup by the authored faceId (unicode faces can repeat across rows).
      .filter((f, i, arr) => arr.findIndex((o) => o.faceId === f.faceId) === i);

    const term = kw.trim().toLowerCase();
    const filtered = term
      ? faces.filter((f) => f.faceText.toLowerCase().includes(term))
      : faces;

    return GROUP_ORDER.map((type) => ({
      type,
      label: GROUP_LABEL[type] ?? '其他',
      items: filtered.filter((f) => f.emojiType === type),
    })).filter((g) => g.items.length > 0);
  }, [query.data, kw]);

  return (
    <div className="weq-face-picker">
      <div className="weq-face-search">
        <Search size={14} />
        <input
          className="weq-face-search-input"
          placeholder="搜索表情"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          autoFocus
        />
      </div>
      <div className="weq-face-scroll">
        {query.isLoading ? (
          <div className="weq-face-empty">加载中…</div>
        ) : groups.length === 0 ? (
          <div className="weq-face-empty">没有匹配的表情</div>
        ) : (
          groups.map((g) => (
            <div key={g.type} className="weq-face-group">
              <div className="weq-face-group-title">{g.label}</div>
              <div className="weq-face-grid">
                {g.items.map((f) => (
                  <button
                    key={f.faceId}
                    type="button"
                    className="weq-face-cell"
                    title={f.faceText}
                    onClick={() => onPick({ faceId: f.faceId, faceText: f.faceText })}
                  >
                    <FaceEmoji element={{ faceId: f.faceId, faceText: f.faceText }} size={26} />
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
