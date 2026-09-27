/**
 * 合并转发的「发消息的人」选择器。
 *
 * 两种模式：
 *   - `conversation` —— 从聊天多选进入时，候选人**限制在该会话成员 + 自己**
 *     （模板层已经把成员带进来了，纯客户端过滤即可）。
 *   - `global` —— 从「合成聊天记录」空白卡片进入时，候选是**好友 + 跨群群友**
 *     （走统一搜索 `account.searchQuick`：先好友、后群友，不按群分类）。
 *
 * 两种模式都支持**直接填 QQ 号（头像自动按 uin 拉）+ 昵称**。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ChevronLeft, Search, UserPlus } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { QqAvatar } from '../QqAvatar';

export interface MfPerson {
  uid: string;
  uin: string;
  name: string;
}

/** 去重（uid 优先，其次 uin）：@ 选择器与发送人选择器共用同一份口径。 */
export function dedupePersons(list: MfPerson[]): MfPerson[] {
  const seen = new Set<string>();
  const out: MfPerson[] = [];
  for (const p of list) {
    const key = p.uid || `uin:${p.uin}`;
    if (!p.name.trim() && !p.uin.trim()) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function SenderPicker({
  mode,
  members,
  self,
  onPick,
  onBack,
}: {
  mode: 'conversation' | 'global';
  /** `conversation` 模式的候选人（会话成员）。 */
  members?: MfPerson[];
  /** 自己（两种模式都置顶，别把自己漏了）。 */
  self: MfPerson;
  onPick: (person: MfPerson) => void;
  onBack: () => void;
}): ReactElement {
  const [keyword, setKeyword] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUin, setManualUin] = useState('');
  const [manualName, setManualName] = useState('');

  const needle = keyword.trim();

  const localFiltered = useMemo(() => {
    const base = dedupePersons([self, ...(members ?? [])]);
    if (!needle) return base;
    const term = needle.toLowerCase();
    return base.filter((p) => p.name.toLowerCase().includes(term) || p.uin.includes(term));
  }, [members, self, needle]);

  // 全局模式：防抖后走统一搜索（好友在前、群友在后）。
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    if (mode !== 'global') return;
    const timer = window.setTimeout(() => setDebounced(needle), 220);
    return () => window.clearTimeout(timer);
  }, [mode, needle]);

  const quick = trpc.account.searchQuick.useQuery(
    { keyword: debounced, limit: 20 },
    { enabled: mode === 'global' && debounced.length > 0, staleTime: 30_000 },
  );

  const friends: MfPerson[] = useMemo(() => {
    if (mode !== 'global') return [];
    return dedupePersons(
      (quick.data?.friends ?? []).map((f) => ({
        uid: f.uid,
        uin: f.uin,
        name: f.remark || f.nick || f.uin,
      })),
    );
  }, [mode, quick.data]);

  const groupMembers: MfPerson[] = useMemo(() => {
    if (mode !== 'global') return [];
    return dedupePersons(
      (quick.data?.groupMembers ?? []).map((m) => ({
        uid: m.memberUid,
        uin: m.memberUin,
        name: m.memberDisplay || m.memberUin,
      })),
    );
  }, [mode, quick.data]);

  return (
    <div className="weq-mf-picker">
      <div className="weq-mf-picker-head">
        <button type="button" className="weq-mf-icon-btn" onClick={onBack} title="返回">
          <ChevronLeft size={18} />
        </button>
        <strong>{mode === 'global' ? '选择发送人' : '选择会话成员'}</strong>
        <span className="weq-mf-picker-spacer" />
      </div>

      <div className="weq-mf-search">
        <Search size={14} />
        <input
          className="weq-mf-search-input"
          placeholder={mode === 'global' ? '搜索好友 / 群友（昵称或 QQ 号）' : '搜索会话成员'}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          autoFocus
        />
      </div>

      <div className="weq-mf-picker-scroll">
        {mode === 'global' ? (
          <>
            <div className="weq-mf-section">自己</div>
            <PersonRow person={self} onPick={onPick} />
          </>
        ) : null}
        {mode === 'conversation' ? (
          localFiltered.length === 0 ? (
            <div className="weq-mf-empty">没有匹配的成员</div>
          ) : (
            localFiltered.map((p) => (
              <PersonRow key={p.uid || `uin:${p.uin}`} person={p} onPick={onPick} />
            ))
          )
        ) : !needle ? (
          <div className="weq-mf-empty">输入昵称或 QQ 号开始搜索（好友优先，其次群友）</div>
        ) : quick.isLoading ? (
          <div className="weq-mf-empty">搜索中…</div>
        ) : friends.length === 0 && groupMembers.length === 0 ? (
          <div className="weq-mf-empty">没有匹配的好友或群友，可在下方直接填写</div>
        ) : (
          <>
            {friends.length > 0 ? (
              <>
                <div className="weq-mf-section">好友</div>
                {friends.map((p) => (
                  <PersonRow key={`f:${p.uid || p.uin}`} person={p} onPick={onPick} />
                ))}
              </>
            ) : null}
            {groupMembers.length > 0 ? (
              <>
                <div className="weq-mf-section">群友</div>
                {groupMembers.map((p) => (
                  <PersonRow key={`g:${p.uid || p.uin}`} person={p} onPick={onPick} />
                ))}
              </>
            ) : null}
          </>
        )}
      </div>

      <div className="weq-mf-manual">
        {manualOpen ? (
          <div className="weq-mf-manual-form">
            <div className="weq-mf-manual-row">
              <QqAvatar uin={manualUin.trim()} size={34} />
              <input
                className="weq-mf-input"
                placeholder="QQ 号"
                inputMode="numeric"
                value={manualUin}
                onChange={(e) => setManualUin(e.target.value.replace(/\D/g, ''))}
              />
              <input
                className="weq-mf-input"
                placeholder="昵称"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="weq-mf-primary"
              disabled={manualUin.trim().length < 5}
              onClick={() =>
                onPick({
                  uid: '',
                  uin: manualUin.trim(),
                  name: manualName.trim() || manualUin.trim(),
                })
              }
            >
              使用这个身份
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="weq-mf-manual-toggle"
            onClick={() => setManualOpen(true)}
          >
            <UserPlus size={15} />
            直接填写 QQ 号和昵称
          </button>
        )}
      </div>
    </div>
  );
}

function PersonRow({
  person,
  onPick,
}: {
  person: MfPerson;
  onPick: (person: MfPerson) => void;
}): ReactElement {
  return (
    <button type="button" className="weq-mf-person" onClick={() => onPick(person)}>
      <QqAvatar uin={person.uin} size={30} className="weq-mf-person-avatar" />
      <span className="weq-mf-person-name">{person.name}</span>
      {person.uin && person.uin !== '0' ? (
        <span className="weq-mf-person-uin">{person.uin}</span>
      ) : null}
    </button>
  );
}
