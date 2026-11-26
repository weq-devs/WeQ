import { cloneElement, type ReactNode } from 'react';
import { type SelfProfileKey, useSelfProfileFields } from './SelfProfileFields.shared';

/** 仅本人完整资料页提供编辑器；名片与其他联系人沿用原来的展示内容。 */
export function SelfProfileSlot({
  field,
  children,
  renderValue,
  inline = false,
  valueHasAction = false,
}: {
  field: SelfProfileKey;
  children?: ReactNode;
  renderValue?: (value: ReactNode, editable: boolean) => ReactNode;
  inline?: boolean;
  valueHasAction?: boolean;
}) {
  const context = useSelfProfileFields();
  const editor = context?.fields[field];
  return editor
    ? cloneElement(editor, {
        renderValue: renderValue ?? editor.props.renderValue,
        inline,
        valueHasAction,
      })
    : children;
}
export type { SelfProfileFields, SelfProfileKey } from './SelfProfileFields.shared';
