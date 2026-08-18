/**
 * 单个互动标识的「等级一览」灯箱 —— 点击主弹窗里的标识大图打开。
 *
 * 等级图标不额外发请求：`iconFormat` 模板带 `{level}_{sub_level}_{style}_{size}`
 * 占位（实测服务端给的就是这个模板，见 friend_mutualmark 的 task.har），照
 * `graded[]` 逐级替换即可得到每级图标。`sub_level` 恒为 0；`style` 0 = 点亮态
 * （彩色）、1 = 未点亮态（灰）；`size` 取 `big` 与卡片一致。已达成等级用彩色，
 * 未达成的压灰；无分级数据的标识只回退到当前图标一行。
 */
import { createPortal } from 'react-dom';
import { Award, X } from 'lucide-react';
import type { FriendMark } from '@weq/service';
import { cn } from '../im-template/template/classNames';
import { useEscapeToClose } from '../im-template/template/modalUtils';

/** 按 `iconFormat` 模板拼某等级的图标 URL；模板里没有占位（静态图）时原样返回。 */
function levelIconUrl(format: string, level: number, style: number): string {
  if (!format.includes('{')) return format;
  return format
    .replaceAll('{level}', String(level))
    .replaceAll('{sub_level}', '0')
    .replaceAll('{style}', String(style))
    .replaceAll('{size}', 'big');
}

export function MutualMarkLevelDialog({
  mark,
  onClose,
}: {
  mark: FriendMark;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);

  const rows = mark.levels.length
    ? mark.levels.map((lv) => ({
        level: lv.level,
        name: lv.name || mark.name,
        desc: lv.desc || (lv.threshold > 0 ? `目标 ${lv.threshold}` : ''),
        icon: levelIconUrl(mark.iconFormat, lv.level, lv.level <= mark.level ? 0 : 1),
      }))
    : mark.iconUrl
      ? [{ level: mark.level, name: mark.name, desc: '', icon: mark.iconUrl }]
      : [];

  return createPortal(
    <div
      className="weq-profile-layer weq-mutual-layer"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <section
        className="weq-mutual-levels weq-anim-pop"
        role="dialog"
        aria-modal="true"
        aria-label={`${mark.name} 的等级`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="weq-profile-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={16} />
        </button>

        <header className="weq-mutual-head">
          <h2>{mark.name}</h2>
          {mark.intro ? <p className="weq-mutual-levels-intro">{mark.intro}</p> : null}
        </header>

        <div className="weq-mutual-levels-body">
          {rows.map((row) => {
            const achieved = row.level > 0 && row.level <= mark.level;
            const isCurrent = row.level === mark.level;
            return (
              <div
                key={row.level}
                className={cn('weq-mutual-level', !achieved && 'is-off', isCurrent && 'is-current')}
              >
                <span className="weq-mutual-level-icon">
                  {row.icon ? (
                    <img src={row.icon} alt={row.name} loading="lazy" />
                  ) : (
                    <Award size={26} />
                  )}
                </span>
                <span className="weq-mutual-level-info">
                  <strong>{row.name}</strong>
                  {row.desc ? <span className="weq-mutual-level-desc">{row.desc}</span> : null}
                </span>
                <span className={cn('weq-mutual-level-state', isCurrent && 'is-current')}>
                  {isCurrent ? '当前' : achieved ? '已达成' : '未达成'}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>,
    document.body,
  );
}
