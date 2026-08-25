/**
 * 妙妙工具「Protobuf / JCE 逆向」面板。
 *
 * 输入 hex / base64 → 按 protobuf 或 JCE（QQHook TarsParser 语义）解析为
 * {tag: value} 简洁 JSON。类型不写进 JSON，可转换的值旁给出转换按钮：
 *   - bytes：hex ↔ 文本 / Base64 / 按 protobuf / 按 JCE 嵌套解析（混合嵌套）
 *   - 整数：有符号 ↔ 无符号 / bool / 时间戳 / zigzag / hex
 *   - fixed64/32：整数 ↔ float
 *   - 字符串：文本 ↔ hex
 */

import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { Check, Copy, Eraser, Play } from 'lucide-react';
import {
  bytesToBase64,
  bytesToHex,
  decodeJce,
  decodeProtobuf,
  groupRvNodes,
  parseInput,
  rvIntDisplay,
  rvNodesToJson,
  rvTimestampRange,
  tryDecodeJce,
  tryDecodeProtobuf,
  tryUtf8,
  type RvInputFormat,
  type RvNode,
  type RvValue,
} from '@weq/codec/raw';

/** 一个演示用的 JCE 结构（含 LIST / MAP / 嵌套 STRUCT / 内部嵌 protobuf）。 */
const SAMPLE_HEX =
  '0a 16 02 68 69 22 00 00 00 2a 3c 40 ff ' +
  '53 01 02 03 04 05 06 07 08 65 3f f8 00 00 00 00 00 00 ' +
  '79 02 00 00 00 03 00 01 00 02 00 03 ' +
  '88 00 01 06 01 6b 16 01 76 ' +
  '9d 00 00 04 de ad be ef ' +
  'aa 10 07 0b ' +
  'bd 00 00 06 08 01 12 02 68 69 ' +
  '0b';

type ParseKind = 'protobuf' | 'jce';
type ParseFormat = 'auto' | ParseKind;
type RvEncoding = RvInputFormat;

interface RvResult {
  bytes: Uint8Array;
  nodes: RvNode[];
  kind: ParseKind;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function bytesLabel(b: Uint8Array): string {
  return `${b.length} 字节`;
}

/** 按对象身份分配稳定 key（同一 AST 节点跨渲染不变）。 */
const rvItemIds = new WeakMap<object, number>();
let rvItemSeq = 0;
function rvItemKey(obj: object): string {
  let id = rvItemIds.get(obj);
  if (id === undefined) {
    id = rvItemSeq++;
    rvItemIds.set(obj, id);
  }
  return `n${id}`;
}

// ---------------------------------------------------------------------------
// 主面板
// ---------------------------------------------------------------------------

export function ReverseTool(): ReactElement {
  const [input, setInput] = useState('');
  const [encoding, setEncoding] = useState<RvEncoding>('auto');
  const [format, setFormat] = useState<ParseFormat>('auto');
  const [result, setResult] = useState<RvResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [parseSeq, setParseSeq] = useState(0);

  const runParse = useCallback((text: string, enc: RvEncoding, fmt: ParseFormat) => {
    try {
      const bytes = parseInput(text, enc);
      let nodes: RvNode[];
      let kind: ParseKind;
      if (fmt === 'protobuf') {
        nodes = decodeProtobuf(bytes);
        kind = 'protobuf';
      } else if (fmt === 'jce') {
        nodes = decodeJce(bytes);
        kind = 'jce';
      } else {
        const proto = tryDecodeProtobuf(bytes);
        const jce = tryDecodeJce(bytes);
        if (proto) {
          nodes = proto;
          kind = 'protobuf';
        } else if (jce) {
          nodes = jce;
          kind = 'jce';
        } else {
          setResult(null);
          setError('无法识别为 protobuf 或 JCE。请检查输入是否为完整的 hex / base64 字节。');
          return;
        }
      }
      setResult({ bytes, nodes, kind });
      setError(null);
      setCopied(false);
      setParseSeq((s) => s + 1);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const parse = useCallback(() => {
    if (!input.trim()) {
      setResult(null);
      setError('请先粘贴 hex 或 base64 数据。');
      return;
    }
    runParse(input, encoding, format);
  }, [input, encoding, format, runParse]);

  const fillSample = useCallback(() => {
    setInput(SAMPLE_HEX);
    runParse(SAMPLE_HEX, 'auto', format);
  }, [format, runParse]);

  const clearAll = useCallback(() => {
    setInput('');
    setResult(null);
    setError(null);
    setCopied(false);
  }, []);

  const copyJson = useCallback(() => {
    if (!result) return;
    const json = rvNodesToJson(result.nodes);
    void navigator.clipboard.writeText(JSON.stringify(json, null, 2)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [result]);

  const fieldCount = useMemo(() => (result ? groupRvNodes(result.nodes).length : 0), [result]);

  return (
    <div className="weq-wtools-rv">
      {/* 输入区 */}
      <div className="weq-wtools-rv-input">
        <div className="weq-wtools-rv-input-head">
          <span className="weq-wtools-rv-label">输入</span>
          <div className="weq-wtools-rv-seg" role="tablist" aria-label="输入编码">
            {(['auto', 'hex', 'base64'] as const).map((e) => (
              <button
                key={e}
                type="button"
                role="tab"
                aria-selected={encoding === e}
                className={`weq-wtools-rv-seg-btn${encoding === e ? ' is-on' : ''}`}
                onClick={() => setEncoding(e)}
              >
                {e === 'auto' ? '自动' : e.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <textarea
          className="weq-wtools-rv-textarea"
          value={input}
          spellCheck={false}
          rows={4}
          placeholder={'粘贴 hex（可含空格 / 冒号 / 0x）或 base64…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) parse();
          }}
        />
        <div className="weq-wtools-rv-actions">
          <button type="button" className="weq-wtools-rv-primary" onClick={parse}>
            <Play size={13} strokeWidth={2} />
            解析
          </button>
          <button
            type="button"
            className="weq-wtools-rv-btn"
            onClick={fillSample}
            title="填入一个含 LIST / MAP / 嵌套 protobuf 的 JCE 示例"
          >
            示例
          </button>
          <button type="button" className="weq-wtools-rv-btn" onClick={clearAll} title="清空">
            <Eraser size={13} strokeWidth={1.9} />
            清空
          </button>
          <span className="weq-wtools-rv-hint">Ctrl/⌘ + Enter 快速解析</span>
        </div>
      </div>

      {error ? <div className="weq-wtools-rv-error">{error}</div> : null}

      {result ? (
        <div className="weq-wtools-rv-result">
          <div className="weq-wtools-rv-result-head">
            <span className={`weq-wtools-rv-kind is-${result.kind}`}>{result.kind}</span>
            <span className="weq-wtools-rv-meta">
              {fieldCount} 个字段 · {bytesLabel(result.bytes)}
            </span>
            <div className="weq-wtools-rv-seg" role="tablist" aria-label="解析格式">
              {(['auto', 'protobuf', 'jce'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={format === f}
                  className={`weq-wtools-rv-seg-btn${format === f ? ' is-on' : ''}`}
                  title={
                    f === 'auto' ? '自动：先尝试 protobuf，失败再尝试 JCE' : `强制按 ${f} 解析`
                  }
                  onClick={() => {
                    setFormat(f);
                    runParse(input, encoding, f);
                  }}
                >
                  {f === 'auto' ? '自动' : f === 'protobuf' ? 'protobuf' : 'JCE'}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="weq-wtools-rv-copy"
              onClick={copyJson}
              title="复制完整 JSON"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? '已复制' : '复制 JSON'}
            </button>
          </div>
          <div className="weq-wtools-rv-json">
            <RvObject key={parseSeq} nodes={result.nodes} path="root" depth={0} comma={false} />
          </div>
        </div>
      ) : (
        <div className="weq-wtools-rv-empty">
          <span>粘贴 protobuf / JCE 字节后点击「解析」，结果以 {`{tag: value}`} 形式展示。</span>
          <span>bytes 字段可一键转文本、Base64，或按 protobuf / JCE 嵌套解析（混合嵌套）。</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON 树
// ---------------------------------------------------------------------------

/** 渲染一个对象块：{ 子行… } */
function RvObject({
  nodes,
  path,
  depth,
  comma,
}: {
  nodes: RvNode[];
  path: string;
  depth: number;
  comma: boolean;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const groups = useMemo(() => groupRvNodes(nodes), [nodes]);
  if (collapsed) {
    return (
      <button
        type="button"
        className="weq-wtools-rv-fold"
        style={{ marginLeft: depth * 14 }}
        onClick={() => setCollapsed(false)}
        title="展开"
      >
        {`{…}`}
      </button>
    );
  }
  return (
    <div className="weq-wtools-rv-container">
      <div className="weq-wtools-rv-brace" style={{ paddingLeft: depth * 14 }}>
        {'{'}
      </div>
      <div className="weq-wtools-rv-tree">
        {groups.map((g, i) => (
          <RvRow
            key={`${path}.${g.tag}`}
            tag={g.tag}
            values={g.values}
            path={`${path}.${g.tag}`}
            depth={depth + 1}
            comma={i < groups.length - 1}
          />
        ))}
      </div>
      <div className="weq-wtools-rv-brace" style={{ paddingLeft: depth * 14 }}>
        {'}'}
        {comma ? <span className="weq-wtools-rv-comma">,</span> : null}
      </div>
    </div>
  );
}

/** JCE LIST：每个元素带自己的 tag。 */
function RvList({
  items,
  path,
  depth,
  comma,
}: {
  items: RvNode[];
  path: string;
  depth: number;
  comma: boolean;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    return (
      <button
        type="button"
        className="weq-wtools-rv-fold"
        style={{ marginLeft: depth * 14 }}
        onClick={() => setCollapsed(false)}
        title="展开"
      >
        {`[…${items.length}]`}
      </button>
    );
  }
  return (
    <div className="weq-wtools-rv-container">
      <div className="weq-wtools-rv-brace" style={{ paddingLeft: depth * 14 }}>
        {'['}
      </div>
      {items.map((it, i) => (
        <div
          className="weq-wtools-rv-row"
          style={{ paddingLeft: (depth + 1) * 14 }}
          key={`${path}.${rvItemKey(it)}`}
        >
          <span className="weq-wtools-rv-tag">{`t${it.tag}`}</span>
          <RvValueView
            v={it.value}
            path={`${path}.${i}`}
            depth={depth + 1}
            comma={i < items.length - 1}
          />
        </div>
      ))}
      <div className="weq-wtools-rv-brace" style={{ paddingLeft: depth * 14 }}>
        {']'}
        {comma ? <span className="weq-wtools-rv-comma">,</span> : null}
      </div>
    </div>
  );
}

/** JCE MAP：{"key": value}。 */
function RvMap({
  entries,
  path,
  depth,
  comma,
}: {
  entries: { key: RvValue; value: RvNode }[];
  path: string;
  depth: number;
  comma: boolean;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    return (
      <button
        type="button"
        className="weq-wtools-rv-fold"
        style={{ marginLeft: depth * 14 }}
        onClick={() => setCollapsed(false)}
        title="展开"
      >
        {`{…${entries.length}}`}
      </button>
    );
  }
  return (
    <div className="weq-wtools-rv-container">
      <div className="weq-wtools-rv-brace" style={{ paddingLeft: depth * 14 }}>
        {'{'}
      </div>
      {entries.map((e, i) => (
        <div
          className="weq-wtools-rv-row"
          style={{ paddingLeft: (depth + 1) * 14 }}
          key={`${path}.${rvItemKey(e)}`}
        >
          <span className="weq-wtools-rv-key">"{rvKeyDisplay(e.key)}":</span>
          <RvValueView
            v={e.value.value}
            path={`${path}.${i}`}
            depth={depth + 1}
            comma={i < entries.length - 1}
          />
        </div>
      ))}
      <div className="weq-wtools-rv-brace" style={{ paddingLeft: depth * 14 }}>
        {'}'}
        {comma ? <span className="weq-wtools-rv-comma">,</span> : null}
      </div>
    </div>
  );
}

function rvKeyDisplay(key: RvValue): string {
  switch (key.k) {
    case 'int':
      return rvIntDisplay(key).toString();
    case 'str':
      return key.text;
    case 'float':
      return String(key.n);
    case 'bytes':
      return truncate(bytesToHex(key.bytes), 48);
    default:
      return '…';
  }
}

/** 一行字段："tag": value。重复 tag 合并为数组。 */
function RvRow({
  tag,
  values,
  path,
  depth,
  comma,
}: {
  tag: number;
  values: RvValue[];
  path: string;
  depth: number;
  comma: boolean;
}): ReactElement {
  if (values.length === 1) {
    return (
      <div className="weq-wtools-rv-row" style={{ paddingLeft: depth * 14 }}>
        <span className="weq-wtools-rv-key">"{tag}":</span>
        <RvValueView v={values[0]!} path={path} depth={depth} comma={comma} />
      </div>
    );
  }
  const allInline = values.every(
    (v) => v.k === 'int' || v.k === 'float' || v.k === 'fixed' || v.k === 'str' || v.k === 'bytes',
  );
  return (
    <div className="weq-wtools-rv-row" style={{ paddingLeft: depth * 14 }}>
      <span className="weq-wtools-rv-key">"{tag}":</span>
      {allInline ? (
        <span className="weq-wtools-rv-inline-arr">
          <span className="weq-wtools-rv-punct">[</span>
          {values.map((v, i) => (
            <span key={rvItemKey(v)}>
              <RvValueView v={v} path={`${path}[${i}]`} depth={depth} comma={false} />
              {i < values.length - 1 ? <span className="weq-wtools-rv-punct">, </span> : null}
            </span>
          ))}
          <span className="weq-wtools-rv-punct">]</span>
          {comma ? <span className="weq-wtools-rv-comma">,</span> : null}
        </span>
      ) : (
        <span className="weq-wtools-rv-block-arr">
          <span className="weq-wtools-rv-punct">[</span>
          <div className="weq-wtools-rv-tree">
            {values.map((v, i) => (
              <div
                className="weq-wtools-rv-row"
                style={{ paddingLeft: (depth + 1) * 14 }}
                key={rvItemKey(v)}
              >
                <RvValueView
                  v={v}
                  path={`${path}[${i}]`}
                  depth={depth + 1}
                  comma={i < values.length - 1}
                />
              </div>
            ))}
          </div>
          <div className="weq-wtools-rv-brace" style={{ paddingLeft: depth * 14 }}>
            {']'}
            {comma ? <span className="weq-wtools-rv-comma">,</span> : null}
          </div>
        </span>
      )}
    </div>
  );
}

function RvValueView({
  v,
  path,
  depth,
  comma,
}: {
  v: RvValue;
  path: string;
  depth: number;
  comma: boolean;
}): ReactElement {
  switch (v.k) {
    case 'int':
      return <RvInt v={v} comma={comma} />;
    case 'float':
      return (
        <span className="weq-wtools-rv-value">
          <span className="weq-wtools-rv-num">{String(v.n)}</span>
          <RvComma comma={comma} />
        </span>
      );
    case 'fixed':
      return <RvFixed v={v} comma={comma} />;
    case 'str':
      return <RvStr v={v} comma={comma} />;
    case 'bytes':
      return <RvBytes v={v} path={path} depth={depth} comma={comma} />;
    case 'obj':
      return <RvObject nodes={v.fields} path={path} depth={depth} comma={comma} />;
    case 'list':
      return <RvList items={v.items} path={path} depth={depth} comma={comma} />;
    case 'map':
      return <RvMap entries={v.entries} path={path} depth={depth} comma={comma} />;
  }
}

function RvComma({ comma }: { comma: boolean }): ReactElement | null {
  return comma ? <span className="weq-wtools-rv-comma">,</span> : null;
}

// ---------------------------------------------------------------------------
// 标量值 + 转换按钮
// ---------------------------------------------------------------------------

function hexOfInt(raw: bigint, bits: number): string {
  if (bits > 0) {
    return raw.toString(16).padStart(bits / 4, '0');
  }
  return raw.toString(16);
}

/** 整数：默认按类型展示，可切换 bool / 时间 / 无符号 / zigzag / hex。 */
function RvInt({ v, comma }: { v: Extract<RvValue, { k: 'int' }>; comma: boolean }): ReactElement {
  const [view, setView] = useState<'dec' | 'bool' | 'time' | 'unsigned' | 'zigzag' | 'hex'>('dec');
  const display = rvIntDisplay(v);
  const canBool = v.raw === 0n || v.raw === 1n;
  const ts = rvTimestampRange(v.raw);
  const canZigzag = v.bits === 0;
  const canUnsigned = v.bits > 0;

  let shown: string;
  let cls = 'weq-wtools-rv-num';
  switch (view) {
    case 'bool':
      shown = v.raw === 1n ? 'true' : 'false';
      cls = 'weq-wtools-rv-str';
      break;
    case 'time':
      shown = ts ? new Date(ts.value).toLocaleString() : String(display);
      break;
    case 'unsigned':
      shown = v.raw.toString();
      break;
    case 'zigzag':
      shown = v.bits === 0 ? ((v.raw >> 1n) ^ -(v.raw & 1n)).toString() : String(display);
      break;
    case 'hex':
      shown = `0x${hexOfInt(v.raw, v.bits)}`;
      break;
    default:
      shown = display.toString();
  }

  const toggles: { key: typeof view; label: string }[] = [];
  if (canBool) toggles.push({ key: 'bool', label: 'bool' });
  if (ts) toggles.push({ key: 'time', label: '时间' });
  if (canUnsigned) toggles.push({ key: 'unsigned', label: '无符号' });
  if (canZigzag) toggles.push({ key: 'zigzag', label: 'zigzag' });
  toggles.push({ key: 'hex', label: 'hex' });

  return (
    <span className="weq-wtools-rv-value">
      <span className={`${cls}${view !== 'dec' ? ' weq-wtools-rv-converted' : ''}`}>{shown}</span>
      {toggles.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`weq-wtools-rv-mini${view === t.key ? ' is-on' : ''}`}
          onClick={() => setView(view === t.key ? 'dec' : t.key)}
        >
          {t.label}
        </button>
      ))}
      <RvComma comma={comma} />
    </span>
  );
}

/** protobuf wire 1/5 定长块：整数 ↔ float。 */
function RvFixed({
  v,
  comma,
}: {
  v: Extract<RvValue, { k: 'fixed' }>;
  comma: boolean;
}): ReactElement {
  const [showFloat, setShowFloat] = useState(false);
  const dv = new DataView(v.bytes.buffer, v.bytes.byteOffset, v.bytes.length);
  if (showFloat) {
    const f = v.bits === 64 ? dv.getFloat64(0, true) : dv.getFloat32(0, true);
    return (
      <span className="weq-wtools-rv-value">
        <span className="weq-wtools-rv-num">{String(f)}</span>
        <button
          type="button"
          className="weq-wtools-rv-mini is-on"
          onClick={() => setShowFloat(false)}
        >
          整数
        </button>
        <RvComma comma={comma} />
      </span>
    );
  }
  const u = v.bits === 64 ? dv.getBigUint64(0, true) : BigInt(dv.getUint32(0, true));
  return (
    <span className="weq-wtools-rv-value">
      <span className="weq-wtools-rv-num">{u.toString()}</span>
      <button type="button" className="weq-wtools-rv-mini" onClick={() => setShowFloat(true)}>
        float
      </button>
      <RvComma comma={comma} />
    </span>
  );
}

/** JCE 字符串：文本 ↔ hex。 */
function RvStr({ v, comma }: { v: Extract<RvValue, { k: 'str' }>; comma: boolean }): ReactElement {
  const [showHex, setShowHex] = useState(false);
  return (
    <span className="weq-wtools-rv-value">
      <span className="weq-wtools-rv-str">
        {showHex ? JSON.stringify(truncate(bytesToHex(v.bytes), 96)) : JSON.stringify(v.text)}
      </span>
      {v.bytes.length > 0 ? (
        <button
          type="button"
          className={`weq-wtools-rv-mini${showHex ? ' is-on' : ''}`}
          onClick={() => setShowHex(!showHex)}
        >
          {showHex ? '文本' : 'Hex'}
        </button>
      ) : null}
      <RvComma comma={comma} />
    </span>
  );
}

type RvBytesMode = 'hex' | 'utf8' | 'base64' | 'proto' | 'jce';

/** bytes：hex / 文本 / Base64 / 按 protobuf / 按 JCE 嵌套解析。 */
function RvBytes({
  v,
  path,
  depth,
  comma,
}: {
  v: Extract<RvValue, { k: 'bytes' }>;
  path: string;
  depth: number;
  comma: boolean;
}): ReactElement {
  const [mode, setMode] = useState<RvBytesMode>(tryUtf8(v.bytes) ? 'utf8' : 'hex');
  const [expanded, setExpanded] = useState(false);
  const utf8 = useMemo(() => tryUtf8(v.bytes), [v.bytes]);
  const proto = useMemo(() => tryDecodeProtobuf(v.bytes), [v.bytes]);
  const jce = useMemo(() => tryDecodeJce(v.bytes), [v.bytes]);

  if (mode === 'proto' && proto) {
    return (
      <span className="weq-wtools-rv-value weq-wtools-rv-nested">
        <span className="weq-wtools-rv-nested-badge">
          <button type="button" className="weq-wtools-rv-mini is-on" onClick={() => setMode('hex')}>
            收起
          </button>
          按 protobuf 解析
        </span>
        <RvObject nodes={proto} path={`${path}.proto`} depth={depth} comma={comma} />
      </span>
    );
  }
  if (mode === 'jce' && jce) {
    return (
      <span className="weq-wtools-rv-value weq-wtools-rv-nested">
        <span className="weq-wtools-rv-nested-badge">
          <button type="button" className="weq-wtools-rv-mini is-on" onClick={() => setMode('hex')}>
            收起
          </button>
          按 JCE 解析
        </span>
        <RvObject nodes={jce} path={`${path}.jce`} depth={depth} comma={comma} />
      </span>
    );
  }

  const hex = bytesToHex(v.bytes);
  const long = hex.length > 96;
  let shown: string;
  switch (mode) {
    case 'utf8':
      shown = JSON.stringify(utf8 ?? '');
      break;
    case 'base64':
      shown = JSON.stringify(bytesToBase64(v.bytes));
      break;
    default:
      shown = JSON.stringify(expanded || !long ? hex : truncate(hex, 96));
  }

  return (
    <span className="weq-wtools-rv-value">
      <span className={`weq-wtools-rv-str${mode !== 'hex' ? ' weq-wtools-rv-converted' : ''}`}>
        {shown}
      </span>
      {long ? (
        <button
          type="button"
          className="weq-wtools-rv-mini"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? '收起' : '展开全部字节'}
        >
          {expanded ? '收起' : `${hex.length / 2} 字节`}
        </button>
      ) : null}
      {utf8 ? (
        <button
          type="button"
          className={`weq-wtools-rv-mini${mode === 'utf8' ? ' is-on' : ''}`}
          onClick={() => setMode(mode === 'utf8' ? 'hex' : 'utf8')}
        >
          文本
        </button>
      ) : null}
      <button
        type="button"
        className={`weq-wtools-rv-mini${mode === 'base64' ? ' is-on' : ''}`}
        onClick={() => setMode(mode === 'base64' ? 'hex' : 'base64')}
      >
        Base64
      </button>
      {proto ? (
        <button
          type="button"
          className={`weq-wtools-rv-mini${mode === 'proto' ? ' is-on' : ''}`}
          onClick={() => setMode(mode === 'proto' ? 'hex' : 'proto')}
        >
          protobuf
        </button>
      ) : null}
      {jce ? (
        <button
          type="button"
          className={`weq-wtools-rv-mini${mode === 'jce' ? ' is-on' : ''}`}
          onClick={() => setMode(mode === 'jce' ? 'hex' : 'jce')}
        >
          JCE
        </button>
      ) : null}
      <RvComma comma={comma} />
    </span>
  );
}
