/**
 * 群成员重合 · 交集成员卡片。
 *
 * 和弦图 / 矩阵里点「一对群」时浮出的卡片：上面是两群头像与共同人数，下面是这批
 * 共同成员。点成员交给应用层打开标准资料卡（`MemberProfileCard`），这里不自己造一套
 * 用户卡片 —— 头像、资料字段、私聊入口都与聊天里点成员完全一致。
 */

import { useMemo } from 'react';
import { ArrowLeftRight, X } from 'lucide-react';
import type { RawNode, RelationGraphData } from './types';
import { groupAvatar, personAvatar } from './graphModel';

export interface OverlapPairSelection {
  a: string;
  b: string;
  weight: number;
  ratio: number;
}

export function OverlapPairCard({
  selection,
  data,
  onClose,
  onOpenMember,
}: {
  selection: OverlapPairSelection;
  data: RelationGraphData;
  onClose: () => void;
  onOpenMember: (
    node: RawNode,
    anchor: { x: number; y: number },
    group: { code: string; name: string },
  ) => void;
}) {
  const groupA = data.groups.find((group) => group.code === selection.a);
  const groupB = data.groups.find((group) => group.code === selection.b);

  const members = useMemo(() => {
    const list = data.nodes.filter(
      (node) => node.groupCodes.includes(selection.a) && node.groupCodes.includes(selection.b),
    );
    // 好友在前，其次按亲密度，最后按名字，保证列表读起来有顺序。
    return list.sort((left, right) => {
      if (left.isFriend !== right.isFriend) return left.isFriend ? -1 : 1;
      if ((right.intimacy || 0) !== (left.intimacy || 0)) {
        return (right.intimacy || 0) - (left.intimacy || 0);
      }
      return displayName(left).localeCompare(displayName(right), 'zh');
    });
  }, [data, selection.a, selection.b]);

  const nameA = groupA?.name || selection.a;
  const nameB = groupB?.name || selection.b;
  const smaller = Math.min(
    Math.max(groupA?.memberCount ?? 0, 0),
    Math.max(groupB?.memberCount ?? 0, 0),
  );
  const ratio = smaller > 0 ? selection.weight / smaller : selection.ratio;
  const percent = Math.round(ratio * 100);
  const friendCount = members.filter((node) => node.isFriend).length;

  return (
    <div className="weq-ov-paircard">
      <button className="weq-ov-paircard-close" type="button" onClick={onClose} title="关闭">
        <X size={14} />
      </button>

      <div className="weq-ov-paircard-head">
        <span className="weq-ov-paircard-avatars">
          <GroupDot code={selection.a} name={nameA} />
          <GroupDot code={selection.b} name={nameB} />
        </span>
        <div className="weq-ov-paircard-title">
          <strong title={nameA}>{nameA}</strong>
          <strong className="is-second" title={nameB}>
            <ArrowLeftRight size={10} className="weq-ov-paircard-link" aria-hidden />
            {nameB}
          </strong>
          <span>
            共同 <b>{selection.weight}</b> 人{percent > 0 ? ` · 覆盖较小群的 ${percent}%` : ''}
          </span>
        </div>
      </div>

      <div className="weq-ov-paircard-meter" aria-hidden>
        <i
          style={{ width: `${Math.min(100, Math.max(selection.weight > 0 ? 3 : 0, percent))}%` }}
        />
      </div>

      <div className="weq-ov-paircard-meta">
        <span>{members.length} 位</span>
        {friendCount > 0 ? <span>{friendCount} 位是好友</span> : null}
        <span>{Math.max(0, Math.round((1 - ratio) * 100))}% 不重叠</span>
      </div>

      <div className="weq-ov-paircard-list">
        {members.length === 0 ? (
          <p className="weq-ov-paircard-empty">这两群没有共同成员 —— 也许该互相介绍认识一下。</p>
        ) : (
          members.slice(0, 200).map((node) => (
            <button
              key={node.uid}
              type="button"
              className="weq-ov-paircard-row"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onOpenMember(
                  node,
                  { x: rect.left + rect.width / 2, y: rect.bottom },
                  { code: selection.a, name: nameA },
                );
              }}
            >
              <span className="weq-ov-paircard-avatar">
                {personAvatar(node.uin) ? (
                  <img
                    src={personAvatar(node.uin) ?? ''}
                    alt=""
                    referrerPolicy="no-referrer"
                    loading="lazy"
                  />
                ) : (
                  <span>{displayName(node).slice(0, 1)}</span>
                )}
              </span>
              <span className="weq-ov-paircard-name" title={displayName(node)}>
                {displayName(node)}
              </span>
              {node.isFriend ? <span className="weq-ov-paircard-tag">好友</span> : null}
              {node.groupCount > 2 ? (
                <span className="weq-ov-paircard-count">{node.groupCount} 群</span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function GroupDot({ code, name }: { code: string; name: string }) {
  const avatar = groupAvatar(code);
  return (
    <span className="weq-ov-paircard-group">
      {avatar ? (
        <img src={avatar} alt="" referrerPolicy="no-referrer" loading="lazy" />
      ) : (
        <span>{(name || '?').slice(0, 1)}</span>
      )}
    </span>
  );
}

function displayName(node: RawNode): string {
  return node.card || node.nick || node.uin || node.uid;
}
