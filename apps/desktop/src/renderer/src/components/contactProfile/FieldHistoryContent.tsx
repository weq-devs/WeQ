import { EmptyState } from '../EmptyState';
import { useState } from 'react';
import { curveStepAfter, line, scaleLinear, scaleTime } from 'd3';
import {
  preciseTimeFormatter,
  dateFormatter,
  clockFormatter,
  preciseClockFormatter,
} from '@weq/time';
import { ArrowDown, ArrowRight, ArrowUp, History } from 'lucide-react';
import {
  fieldHistoryItems,
  fieldHistoryMode,
  fieldHistoryText,
  fieldItemChanges,
  historyNumber,
  presentFieldHistoryRows,
  type FieldHistoryRow,
  type HistoryItem,
} from '../../lib/contactFieldPresentation';
import { albumMediaUrl, qqShowUrl } from '../../lib/resourceUrl';
import { ContactHistoryAvatar } from './ContactHistoryAvatar';
import { MediaPreview } from '../MediaPreview';
import '../../styles/field-history.css';

export function FieldHistoryContent({
  field,
  label,
  rows: inputRows,
  hasOlder = false,
}: {
  field: string;
  label: string;
  rows: FieldHistoryRow[];
  hasOlder?: boolean;
}) {
  const mode = fieldHistoryMode(field);
  const rows = presentFieldHistoryRows(field, inputRows);
  if (!rows.length)
    return <EmptyState compact role="status" icon={<History />} title="暂无这项资料的历史记录" />;
  return (
    <div className={`weq-field-presentation is-${mode}`} data-field={field} data-privacy-sensitive>
      {mode === 'trend' ? <FieldTrend field={field} label={label} rows={rows} /> : null}
      <ol className="weq-field-records">
        {rows.map((row, index) => {
          const previous = rows[index + 1];
          const delta =
            previous && historyNumber(row.value) !== null && historyNumber(previous.value) !== null
              ? Number(row.value) - Number(previous.value)
              : null;
          return (
            <li key={row.id}>
              <div className="weq-field-record-time">
                <time dateTime={new Date(row.first_at).toISOString()}>
                  观察于 {preciseTimeFormatter.format(row.first_at)}
                </time>
                {row.last_at > row.first_at ? (
                  <small>最近观察 {preciseTimeFormatter.format(row.last_at)}</small>
                ) : null}
              </div>
              {mode === 'gallery' ? (
                <FieldGallery field={field} value={row.value} />
              ) : mode === 'collection' ? (
                <CollectionRecord field={field} row={row} previous={previous} />
              ) : (
                <div className="weq-field-record-value">
                  <span>{fieldHistoryText(field, row.value)}</span>
                  {mode === 'trend' && delta !== null ? (
                    <span className="weq-field-delta">
                      {delta > 0 ? (
                        <ArrowUp size={12} />
                      ) : delta < 0 ? (
                        <ArrowDown size={12} />
                      ) : null}
                      {delta > 0 ? '+' : ''}
                      {delta.toLocaleString('zh-CN')}
                    </span>
                  ) : null}
                </div>
              )}
              {mode === 'changes' && previous ? (
                <div className="weq-field-previous">
                  <span>之前</span> {fieldHistoryText(field, previous.value)}
                </div>
              ) : null}
              {!previous && !hasOlder ? <small className="weq-field-first">最早记录</small> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function FieldTrend({
  field,
  label,
  rows,
}: {
  field: string;
  label: string;
  rows: FieldHistoryRow[];
}) {
  const points = [...rows].reverse();
  const numbers = points.flatMap((r) => (historyNumber(r.value) === null ? [] : [Number(r.value)]));
  if (numbers.length < 2) return null;
  const width = 368,
    height = 172;
  const first = points[0]!.first_at,
    last = points.at(-1)!.first_at;
  const min = Math.min(...numbers),
    max = Math.max(...numbers);
  const padding = Math.max((max - min) * 0.12, 1);
  const axisTime = (at: number) =>
    last - first < 1000
      ? preciseClockFormatter.format(at)
      : last - first < 86400000
        ? clockFormatter.format(at, 'second')
        : dateFormatter.format(at);
  const y = scaleLinear()
    .domain([min < 0 ? min - padding : Math.max(0, min - padding), max + padding])
    .nice(3)
    .range([height - 28, 12]);
  const x = scaleTime()
    .domain([new Date(first), new Date(last === first ? last + 1 : last)])
    .range([52, width - 14]);
  const path = line<FieldHistoryRow>()
    .defined((r) => historyNumber(r.value) !== null)
    .x((r) => x(r.first_at))
    .y((r) => y(Number(r.value)))
    .curve(curveStepAfter)(points);
  return (
    <figure className="weq-field-trend">
      <figcaption>
        {label}观察趋势 <span>{points.length} 条已加载记录</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label}观察趋势，${fieldHistoryText(field, points[0]!.value)} 至 ${fieldHistoryText(field, points.at(-1)!.value)}`}
      >
        {y
          .ticks(3)
          .filter(Number.isInteger)
          .map((value) => (
            <g key={value}>
              <line
                className="weq-field-chart-grid"
                x1={52}
                x2={width - 14}
                y1={y(value)}
                y2={y(value)}
              />
              <text x={44} y={y(value) + 4} textAnchor="end">
                {value.toLocaleString('zh-CN', { notation: 'compact' })}
              </text>
            </g>
          ))}
        <path d={path ?? ''} className="weq-field-chart-line" />
        {points
          .filter((r) => historyNumber(r.value) !== null)
          .map((r) => (
            <circle
              key={r.id}
              cx={x(r.first_at)}
              cy={y(Number(r.value))}
              r={3}
              className="weq-field-chart-point"
            >
              <title>
                {preciseTimeFormatter.format(r.first_at)} · {fieldHistoryText(field, r.value)}
              </title>
            </circle>
          ))}
        <text x={52} y={height - 4}>
          {axisTime(first)}
        </text>
        <text x={width - 14} y={height - 4} textAnchor="end">
          {axisTime(last)}
        </text>
      </svg>
    </figure>
  );
}
function ItemList({ items }: { items: HistoryItem[] }) {
  const [limit, setLimit] = useState(20);
  return (
    <>
      <ul className="weq-field-items">
        {items.slice(0, limit).map((item) => (
          <li key={item.key}>
            <span>{item.title}</span>
            {item.detail ? <small>{item.detail}</small> : null}
          </li>
        ))}
      </ul>
      {items.length > limit ? (
        <button
          type="button"
          className="weq-profile-section-action"
          onClick={() => setLimit((v) => v + 20)}
        >
          继续显示（{items.length - limit}）
        </button>
      ) : null}
    </>
  );
}
function CollectionRecord({
  field,
  row,
  previous,
}: {
  field: string;
  row: FieldHistoryRow;
  previous?: FieldHistoryRow;
}) {
  const items = fieldHistoryItems(field, row.value);
  if (!previous)
    return items.length ? (
      <ItemList items={items} />
    ) : (
      <span>{row.value == null ? fieldHistoryText(field, row.value) : '无条目'}</span>
    );
  const changes = fieldItemChanges(items, fieldHistoryItems(field, previous.value));
  return (
    <div className="weq-field-collection-changes">
      {changes.added.length ? (
        <div>
          <strong>新增 {changes.added.length}</strong>
          <ItemList items={changes.added} />
        </div>
      ) : null}
      {changes.removed.length ? (
        <div>
          <strong>不再出现 {changes.removed.length}</strong>
          <ItemList items={changes.removed} />
        </div>
      ) : null}
      {changes.changed.length ? (
        <div>
          <strong>变更 {changes.changed.length}</strong>
          {changes.changed.map(({ before, after }) => (
            <div className="weq-field-item-change" key={after.key}>
              <ItemList items={[before]} />
              <ArrowRight size={14} aria-label="变更为" />
              <ItemList items={[after]} />
            </div>
          ))}
        </div>
      ) : null}
      {!changes.added.length && !changes.removed.length && !changes.changed.length ? (
        <span>条目内容未变</span>
      ) : null}
      <details>
        <summary>本次完整记录（{items.length}）</summary>
        {items.length ? <ItemList items={items} /> : <span>无条目</span>}
      </details>
    </div>
  );
}
function FieldGallery({ field, value }: { field: string; value: unknown }) {
  if (field === 'avatar') return <ContactHistoryAvatar value={value} />;
  const items =
    field === 'qqShow'
      ? typeof value === 'string' && /^https?:\/\//i.test(value)
        ? [{ key: value, title: '历史 QQ 秀', detail: '', image: value }]
        : []
      : fieldHistoryItems(field, value);
  return items.length ? (
    <div className="weq-field-gallery">
      {items.map((item) => (
        <HistoryPhoto key={item.key} item={item} show={field === 'qqShow'} />
      ))}
    </div>
  ) : (
    <span>{value === undefined ? '未记录' : '无图片'}</span>
  );
}
function HistoryPhoto({ item, show }: { item: HistoryItem; show: boolean }) {
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  const src = item.image ? (show ? qqShowUrl(item.image) : albumMediaUrl(item.image)) : '';
  if (!src || failed)
    return (
      <span className="weq-field-photo-unavailable">
        {item.title}
        <small>{failed ? '图片暂不可用' : item.detail}</small>
      </span>
    );
  return (
    <>
      <button
        type="button"
        className={`weq-field-photo${show ? ' is-show' : ''}`}
        title={`查看${item.title}`}
        aria-label={`查看${item.title}`}
        onClick={() => setPreview(true)}
      >
        <img src={src} alt={item.title} loading="lazy" onError={() => setFailed(true)} />
      </button>
      {preview ? (
        <MediaPreview
          label={item.title}
          items={[{ key: src, kind: 'image', src, title: item.title }]}
          onClose={() => setPreview(false)}
        />
      ) : null}
    </>
  );
}
