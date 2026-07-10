/**
 * People picker — a searchable avatar+name list, reused for both the sender
 * chooser and the group @-mention chooser. Avatars are always resolved from the
 * uin (never the DB's stale avatar URL).
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Search } from 'lucide-react';
import { QqAvatar } from '../QqAvatar';

export interface Person {
  uid: string;
  uin: string;
  name: string;
}

export function PeoplePicker({
  people,
  onPick,
  placeholder = '搜索昵称 / QQ 号',
}: {
  people: Person[];
  onPick: (person: Person) => void;
  placeholder?: string;
}): ReactElement {
  const [kw, setKw] = useState('');

  const filtered = useMemo(() => {
    const term = kw.trim().toLowerCase();
    if (!term) return people;
    return people.filter(
      (p) => p.name.toLowerCase().includes(term) || p.uin.includes(term),
    );
  }, [people, kw]);

  return (
    <div className="weq-people-picker">
      <div className="weq-face-search">
        <Search size={14} />
        <input
          className="weq-face-search-input"
          placeholder={placeholder}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          autoFocus
        />
      </div>
      <div className="weq-people-scroll">
        {filtered.length === 0 ? (
          <div className="weq-face-empty">没有匹配的成员</div>
        ) : (
          filtered.map((p) => (
            <button
              key={p.uid || p.uin}
              type="button"
              className="weq-people-row"
              onClick={() => onPick(p)}
            >
              <QqAvatar uin={p.uin} size={30} className="weq-people-avatar" />
              <span className="weq-people-name">{p.name}</span>
              {p.uin && p.uin !== '0' ? (
                <span className="weq-people-uin">{p.uin}</span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
