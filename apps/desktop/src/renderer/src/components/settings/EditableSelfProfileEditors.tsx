import { useContext, useEffect, useRef, useState } from 'react';
import { Check, Save, MapPin, Cake } from 'lucide-react';
import { ProfileEditorRow, ProfileEditorAction } from '../ProfileFieldEditor';
import { ProfileFieldEditorContext } from '../ProfileFieldEditor.shared';
import { useSelfProfileSave } from '../SelfProfileField.shared';

interface Region {
  code: string;
  name: string;
  children: Region[];
}
export function RegionEditor({
  label,
  value,
  layers,
  regions,
  disabled,
  onSave,
}: {
  label: string;
  value: string[] | null;
  layers: 3 | 4;
  regions: Region[];
  disabled: boolean;
  onSave: (value: string[]) => Promise<boolean>;
}) {
  const saveField = useSelfProfileSave();
  const inlineEditor = useContext(ProfileFieldEditorContext);
  const [path, setPath] = useState<Array<string | null>>(
    value ?? Array.from({ length: layers }, () => null),
  );
  const previous = useRef(JSON.stringify(value ?? Array.from({ length: layers }, () => null)));
  const incoming = JSON.stringify(value ?? Array.from({ length: layers }, () => null));
  useEffect(() => {
    const before = previous.current;
    setPath((current) =>
      JSON.stringify(current) === before ? (JSON.parse(incoming) as Array<string | null>) : current,
    );
    previous.current = incoming;
  }, [incoming]);
  const menus: Region[][] = [];
  let siblings = regions;
  for (let i = 0; i < layers; i++) {
    menus.push(siblings);
    siblings = siblings.find((node) => node.code === path[i])?.children ?? [];
  }
  const valid =
    path.length === layers &&
    path.every(
      (value, index) => value !== null && menus[index]?.some((node) => node.code === value),
    );
  return (
    <ProfileEditorRow
      label={
        <span className="weq-set-row-icon">
          <MapPin size={14} />
          {label}
        </span>
      }
      control={
        <div className="weq-profile-region-editor">
          {menus.map((nodes, index) => (
            <select
              key={['country', 'province', 'city', 'district'][index]}
              aria-label={`${label}${['国家', '省', '市', '区县'][index]}`}
              disabled={disabled || !nodes.length || (nodes.length === 1 && nodes[0]?.code === '0')}
              value={path[index] ?? '__unset'}
              onChange={(event) => {
                const next = path.slice(0, index);
                next.push(event.target.value);
                let children =
                  nodes.find((node) => node.code === event.target.value)?.children ?? [];
                for (let depth = index + 1; depth < layers; depth++) {
                  const single = children.length === 1 ? children[0] : undefined;
                  const selected = children.find((node) => node.code === '0') ?? single;
                  next.push(selected?.code ?? null);
                  children = selected?.children ?? [];
                }
                setPath(next);
              }}
            >
              <option value="__unset" data-placeholder disabled>
                {['国家', '省', '市', '区县'][index]}
              </option>
              {nodes.map((node) => (
                <option key={node.code} value={node.code}>
                  {node.name || '未指定'}
                </option>
              ))}
            </select>
          ))}
          <ProfileEditorAction>
            <button
              type="button"
              className={
                inlineEditor ? 'weq-profile-field-tool weq-profile-field-save' : 'weq-set-iconbtn'
              }
              title={`保存${label}`}
              aria-label={`保存${label}`}
              disabled={disabled || inlineEditor?.disabled || !valid}
              onClick={() => {
                if (valid) void saveField(() => onSave(path as string[]));
              }}
            >
              {inlineEditor ? <Check size={14} /> : <Save size={16} />}
            </button>
          </ProfileEditorAction>
        </div>
      }
    />
  );
}
export function BirthdayEditor({
  initial,
  disabled,
  onSave,
}: {
  initial: string;
  disabled: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(initial);
  const saveField = useSelfProfileSave();
  const inlineEditor = useContext(ProfileFieldEditorContext);
  return (
    <ProfileEditorRow
      label={
        <span className="weq-set-row-icon">
          <Cake size={14} />
          生日
        </span>
      }
      control={
        <div className="weq-profile-region-editor weq-profile-birthday-editor">
          <input
            type="date"
            aria-label="公历生日"
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
          />
          <ProfileEditorAction>
            <button
              type="button"
              className={
                inlineEditor ? 'weq-profile-field-tool weq-profile-field-save' : 'weq-set-iconbtn'
              }
              title="保存生日"
              aria-label="保存生日"
              disabled={disabled || inlineEditor?.disabled || !value}
              onClick={() => void saveField(() => onSave(value))}
            >
              {inlineEditor ? <Check size={14} /> : <Save size={16} />}
            </button>
          </ProfileEditorAction>
        </div>
      }
    />
  );
}
