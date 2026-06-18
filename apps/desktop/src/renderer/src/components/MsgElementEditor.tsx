/**
 * MsgElementEditor — A sophisticated editor for raw message elements.
 * Supports nesting, hex editing for bytes, and numeric inputs.
 */

import { useState, useEffect } from 'react';
import { X, Save, ChevronLeft, ChevronRight, Hash, Type, Binary, Box } from 'lucide-react';
import { cn } from '../im-template/template/classNames';

interface Props {
  msgId: string;
  elements: any[];
  onClose: () => void;
  onSave: (elements: any[]) => Promise<void>;
}

export function MsgElementEditor({ msgId, elements: initialElements, onClose, onSave }: Props) {
  const [elements, setElements] = useState<any[]>(JSON.parse(JSON.stringify(initialElements)));
  const [activeIndex, setActiveIndex] = useState(0);
  const [saving, setSending] = useState(false);

  const activeElement = elements[activeIndex];

  const updateActiveElement = (newEl: any) => {
    const next = [...elements];
    next[activeIndex] = newEl;
    setElements(next);
  };

  const handleSave = async () => {
    setSending(true);
    try {
      await onSave(elements);
      onClose();
    } catch (e) {
      console.error('[editor] Save failed:', e);
      alert('保存失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="weq-editor-overlay" role="presentation" onMouseDown={onClose}>
      <div 
        className="weq-editor-dialog" 
        role="dialog" 
        onMouseDown={e => e.stopPropagation()}
      >
        <header className="weq-editor-header">
          <div className="weq-editor-title">
            <h3>修改消息元件</h3>
            <code>msgId: {msgId}</code>
          </div>
          <button className="weq-editor-close" onClick={onClose}><X size={18}/></button>
        </header>

        <div className="weq-editor-tabs">
          {elements.map((_, i) => (
            <button
              key={i}
              className={cn("weq-editor-tab", i === activeIndex && "active")}
              onClick={() => setActiveIndex(i)}
            >
              <span className="weq-editor-tab-index">#{i + 1}</span>
              <span className="weq-editor-tab-kind">{elements[i]?.kind || 'unknown'}</span>
            </button>
          ))}
        </div>

        <main className="weq-editor-body">
          {activeElement ? (
            <div className="weq-editor-content">
               <ObjectEditor 
                 value={activeElement} 
                 onChange={updateActiveElement} 
                 path={[]} 
               />
            </div>
          ) : (
            <div className="weq-editor-empty">无效的元件数据</div>
          )}
        </main>

        <footer className="weq-editor-footer">
          <div className="weq-editor-pager">
             <button 
               disabled={activeIndex <= 0} 
               onClick={() => setActiveIndex(activeIndex - 1)}
             >
               <ChevronLeft size={16}/> 上一个
             </button>
             <span className="weq-editor-pager-count">{activeIndex + 1} / {elements.length}</span>
             <button 
               disabled={activeIndex >= elements.length - 1} 
               onClick={() => setActiveIndex(activeIndex + 1)}
             >
               下一个 <ChevronRight size={16}/>
             </button>
          </div>
          <div className="weq-editor-actions">
            <button className="weq-btn-cancel" onClick={onClose}>取消</button>
            <button 
              className="weq-btn-save" 
              onClick={handleSave} 
              disabled={saving}
            >
              <Save size={16}/> {saving ? '保存中...' : '确认修改'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function ObjectEditor({ value, onChange, path }: { value: any, onChange: (val: any) => void, path: string[] }) {
  if (value === null || value === undefined) return <div className="weq-val-null">null</div>;

  // Render entries for objects
  if (typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value).sort((a, b) => {
        if (a === 'kind') return -1;
        if (b === 'kind') return 1;
        return a.localeCompare(b);
    });

    return (
      <div className="weq-obj-fields">
        {keys.map(key => (
          <div className="weq-field-row" key={key}>
            <div className="weq-field-label">
              <FieldIcon val={value[key]} k={key}/>
              <span title={key}>{key}</span>
            </div>
            <div className="weq-field-value">
              <ValueEditor 
                k={key}
                val={value[key]} 
                onChange={(newVal) => onChange({ ...value, [key]: newVal })}
                path={[...path, key]}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (Array.isArray(value)) {
      return (
          <div className="weq-array-editor">
              {value.map((v, i) => (
                  <div key={i} className="weq-array-item">
                      <div className="weq-array-index">[{i}]</div>
                      <ValueEditor 
                        k={String(i)} 
                        val={v} 
                        onChange={(newVal) => {
                            const next = [...value];
                            next[i] = newVal;
                            onChange(next);
                        }}
                        path={[...path, String(i)]}
                      />
                  </div>
              ))}
          </div>
      )
  }

  return <div className="weq-unsupported">Unsupported type: {typeof value}</div>;
}

function FieldIcon({ val, k }: { val: any, k: string }) {
    if (k === 'kind') return <Box size={14} className="text-blue-500"/>;
    if (typeof val === 'string') return <Type size={14} className="opacity-50"/>;
    if (typeof val === 'number' || typeof val === 'bigint') return <Hash size={14} className="opacity-50"/>;
    if (val && typeof val === 'object' && (val.type === 'Buffer' || Array.isArray(val.data))) return <Binary size={14} className="text-orange-500"/>;
    return <Box size={14} className="opacity-30"/>;
}

function ValueEditor({ k, val, onChange, path }: { k: string, val: any, onChange: (v: any) => void, path: string[] }) {
  // Empty (null/undefined) fields still get an editable text box so a value
  // can be filled in. Treated as a string; the schema-driven encoder coerces
  // it to the field's real type on save.
  if (val === null || val === undefined) {
    return (
      <input
        className="weq-input-text"
        type="text"
        value=""
        placeholder="(空)"
        onChange={e => onChange(e.target.value)}
      />
    );
  }

  // Handle bytes (represented as { type: 'Buffer', data: number[] } or similar after IPC)
  const isBytes = val && typeof val === 'object' && val.type === 'Buffer' && Array.isArray(val.data);
  const isHexLike = val && typeof val === 'object' && Array.isArray(val.data) && !val.type; // fallback

  if (isBytes || isHexLike) {
      const bytes = val.data as number[];
      const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');

      return (
          <textarea
            className="weq-input-hex"
            defaultValue={hex}
            onBlur={(e) => {
                const raw = e.target.value.replace(/[^0-9a-fA-F]/g, '');
                const out = [];
                for(let i=0; i<raw.length; i+=2) {
                    out.push(parseInt(raw.substring(i, i+2), 16));
                }
                onChange({ ...val, data: out });
            }}
          />
      )
  }

  // Empty container (repeated/message field that decoded to [] or {}). There's
  // no scalar to type into and a single box can't build a typed list, so show a
  // muted placeholder box for visual consistency. Left as-is → encodes empty.
  if (typeof val === 'object') {
    const emptyArr = Array.isArray(val) && val.length === 0;
    const emptyObj = !Array.isArray(val) && Object.keys(val).length === 0;
    if (emptyArr || emptyObj) {
      return (
        <input
          className="weq-input-text weq-input-empty"
          type="text"
          readOnly
          value=""
          placeholder={emptyArr ? '空数组 [ ]' : '空对象 { }'}
        />
      );
    }
  }

  if (typeof val === 'string') {
    return (
      <input 
        className="weq-input-text"
        type="text" 
        value={val} 
        onChange={e => onChange(e.target.value)} 
      />
    );
  }

  if (typeof val === 'number') {
    return (
      <input 
        className="weq-input-num"
        type="number" 
        value={val} 
        onChange={e => onChange(Number(e.target.value))} 
      />
    );
  }

  if (typeof val === 'boolean') {
      return (
          <input 
            type="checkbox" 
            checked={val} 
            onChange={e => onChange(e.target.checked)}
          />
      )
  }

  // Nested object or array
  if (typeof val === 'object' && val !== null) {
      return <ObjectEditor value={val} onChange={onChange} path={path} />;
  }

  return <span>{String(val)}</span>;
}
