import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';

/**
 * 名片字段排序区（唯一排序交互基线）：
 *
 * - 拖拽把手与显示开关共用一行；把手获得焦点时方向键也可排序。
 * - 拖动用 HTML5 drag 事件，放到目标行上即交换位置。
 * - 行高与设置页 `Row` 一致，开关复用设置页控件。
 */
export function ContactFieldSort<K extends string>({
  id,
  title,
  keys,
  labels,
  disabled = false,
  sortable = true,
  control,
  onMove,
}: {
  id: string;
  title: string;
  keys: readonly K[];
  labels: (key: K) => string;
  disabled?: boolean;
  sortable?: boolean;
  control: (key: K) => ReactNode;
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
    <ol id={id} className="weq-contact-sort" aria-label={title}>
      {keys.map((key, index) => (
        <li
          key={key}
          data-field={key}
          className={[
            'weq-contact-sort-item',
            dragged === key ? 'is-dragging' : '',
            target === key && dragged && dragged !== key ? 'is-target' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onDragEnd={() => {
            setDragged(null);
            setTarget(null);
          }}
          onDragOver={(event) => {
            if (disabled || !sortable || !dragged) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setTarget(key);
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (!disabled && sortable && dragged && dragged !== key)
              onMove(dragged, index - keys.indexOf(dragged));
            setDragged(null);
            setTarget(null);
          }}
        >
          {sortable ? (
            <button
              type="button"
              className="weq-contact-sort-handle"
              aria-label={`调整${labels(key)}的顺序，方向键可移动`}
              title="拖动或按方向键调整顺序"
              disabled={disabled}
              draggable={!disabled}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', key);
                setDragged(key);
              }}
              onKeyDown={(event) => onKeyDown(event, key)}
            >
              <GripVertical size={14} aria-hidden />
            </button>
          ) : null}
          <span className="weq-contact-sort-label">{labels(key)}</span>
          {control(key)}
        </li>
      ))}
    </ol>
  );
}
