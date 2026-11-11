import { useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';

/**
 * 名片字段排序区（唯一排序交互基线）：
 *
 * - 视觉把手 `GripVertical` + 上移/下移按钮；把手获得焦点时方向键即可排序。
 * - 拖动用 HTML5 drag 事件，放到目标行上即交换位置。
 * - 行高与设置页 `Row` 一致，控件复用 `weq-set-iconbtn`，不另造一套皮肤。
 */
export function ContactFieldSort<K extends string>({
  id,
  title,
  description,
  keys,
  labels,
  disabled = false,
  onMove,
}: {
  id: string;
  title: string;
  description?: string;
  keys: readonly K[];
  labels: (key: K) => string;
  disabled?: boolean;
  onMove: (key: K, offset: number) => void;
}) {
  const [dragged, setDragged] = useState<K | null>(null);
  const [target, setTarget] = useState<K | null>(null);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, key: K) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    onMove(key, event.key === 'ArrowUp' ? -1 : 1);
  }
  return (
    <section className="weq-contact-sort-group" aria-labelledby={`${id}-title`}>
      <div className="weq-contact-sort-head">
        <strong id={`${id}-title`}>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      <ol className="weq-contact-sort" aria-label={title}>
        {keys.map((key, index) => (
          <li
            key={key}
            className={[
              'weq-contact-sort-item',
              dragged === key ? 'is-dragging' : '',
              target === key && dragged && dragged !== key ? 'is-target' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            draggable={!disabled}
            onDragStart={() => setDragged(key)}
            onDragEnd={() => {
              setDragged(null);
              setTarget(null);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setTarget(key);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!dragged || dragged === key) return;
              onMove(dragged, index - keys.indexOf(dragged));
              setDragged(null);
              setTarget(null);
            }}
          >
            <button
              type="button"
              className="weq-contact-sort-handle"
              aria-label={`调整${labels(key)}的顺序，方向键可移动`}
              title="拖动或按方向键调整顺序"
              disabled={disabled}
              onKeyDown={(event) => onKeyDown(event, key)}
            >
              <GripVertical size={14} aria-hidden />
            </button>
            <span className="weq-contact-sort-label">{labels(key)}</span>
            <span className="weq-contact-sort-actions">
              <button
                type="button"
                className="weq-set-iconbtn"
                title="上移"
                aria-label={`上移${labels(key)}`}
                disabled={disabled || index === 0}
                onClick={() => onMove(key, -1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className="weq-set-iconbtn"
                title="下移"
                aria-label={`下移${labels(key)}`}
                disabled={disabled || index === keys.length - 1}
                onClick={() => onMove(key, 1)}
              >
                <ArrowDown size={14} />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
