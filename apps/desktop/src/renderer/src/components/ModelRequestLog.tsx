import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Copy, Braces } from 'lucide-react';
import { preciseClockFormatter } from '@weq/time';
import { formatModelLogText, type ModelLogBlock } from '../lib/modelRequestLog';
import { copyTextToClipboard } from '../im-template/template/clipboard';
import { shikiCodeHighlighter } from '../views/agentlab/shikiHighlighter';
import '../styles/model-request-log.css';

const ModelLogText = memo(function ModelLogText({
  block,
  running,
}: {
  block: ModelLogBlock;
  running: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const formatted = useMemo(
    () => formatModelLogText(block.text, running || block.format === 'text'),
    [block.text, block.format, running],
  );
  const text = raw ? block.text : formatted.text;
  const [highlight, setHighlight] = useState<{
    text: string;
    result: ReturnType<typeof shikiCodeHighlighter.highlight>;
  } | null>(null);
  useEffect(() => {
    if (!formatted.json || raw) return;
    let active = true;
    const options = {
      code: text,
      language: 'json' as const,
      themes: shikiCodeHighlighter.getThemes(),
    };
    const result = shikiCodeHighlighter.highlight(options, (result) => {
      if (active) setHighlight({ text, result });
    });
    setHighlight({ text, result });
    return () => {
      active = false;
    };
  }, [text, formatted.json, raw]);
  const tokens =
    formatted.json && !raw && highlight?.text === text ? highlight.result?.tokens : undefined;
  let offset = 0;
  const highlighted = tokens?.map((line) => {
    const start = offset;
    const spans = line.map((token) => {
      const position = offset;
      offset += token.content.length;
      return (
        <span
          key={position}
          className="weq-model-log-token"
          style={token.htmlStyle as CSSProperties}
        >
          {token.content}
        </span>
      );
    });
    offset += 1;
    return (
      <Fragment key={start}>
        {start > 0 ? '\n' : ''}
        {spans}
      </Fragment>
    );
  });
  return (
    <>
      <div className="weq-model-log-tools">
        {formatted.json ? (
          <button
            type="button"
            title={raw ? '格式化 JSON' : '查看原文'}
            aria-label={`${block.label}：${raw ? '格式化 JSON' : '查看原文'}`}
            aria-pressed={raw}
            onClick={() => setRaw((value) => !value)}
          >
            <Braces size={14} />
          </button>
        ) : null}
        <button
          type="button"
          title="复制原文"
          aria-label={`${block.label}：复制原文`}
          onClick={() => void copyTextToClipboard(block.text)}
        >
          <Copy size={14} />
        </button>
      </div>
      <pre aria-label={block.label}>
        <code>{highlighted ?? text}</code>
      </pre>
    </>
  );
});

export function ModelRequestLog({
  blocks,
  running = false,
}: {
  blocks: readonly ModelLogBlock[];
  running?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const wasRunning = useRef(running);
  useLayoutEffect(() => {
    if (container.current && follow.current && (running || wasRunning.current))
      container.current.scrollTop = container.current.scrollHeight;
    wasRunning.current = running;
  }, [blocks, running]);
  return (
    <div
      ref={container}
      className="weq-model-log"
      role="log"
      aria-live="off"
      aria-label="模型请求日志"
      tabIndex={0}
      onScroll={(event) => {
        const node = event.currentTarget;
        follow.current = node.scrollHeight - node.clientHeight - node.scrollTop < 24;
      }}
    >
      {blocks.length ? (
        blocks.map((block) => (
          <section key={block.id} className={`weq-model-log-block is-${block.level ?? 'info'}`}>
            {block.collapsed ? (
              <details>
                <summary>
                  {block.ts !== undefined ? (
                    <time>{preciseClockFormatter.format(block.ts)}</time>
                  ) : null}
                  {block.label}
                </summary>
                <ModelLogText block={block} running={running} />
              </details>
            ) : (
              <>
                <header>
                  {block.ts !== undefined ? (
                    <time>{preciseClockFormatter.format(block.ts)}</time>
                  ) : null}
                  <span>{block.label}</span>
                </header>
                <ModelLogText block={block} running={running} />
              </>
            )}
          </section>
        ))
      ) : (
        <p className="weq-model-log-empty">暂无模型输出</p>
      )}
    </div>
  );
}
