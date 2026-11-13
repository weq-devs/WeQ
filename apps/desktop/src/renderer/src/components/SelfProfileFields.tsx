import {
  cloneElement,
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
  type ComponentProps,
} from 'react';
import type { SelfProfileField } from './SelfProfileField';

export type SelfProfileKey =
  | 'nickname'
  | 'gender'
  | 'signature'
  | 'birthday'
  | 'region'
  | 'email'
  | 'profession'
  | 'hometown'
  | 'company'
  | 'personalNote'
  | 'education'
  | 'age'
  | 'constellation'
  | 'status'
  | 'extendedStatus'
  | 'personalityLabels'
  | 'anonymousQuestions';
export type SelfProfileFields = Partial<
  Record<SelfProfileKey, ReactElement<ComponentProps<typeof SelfProfileField>>>
>;
export const SelfProfileFieldsContext = createContext<{
  fields: SelfProfileFields;
  uin: string;
  avatarAction?: { onClick: () => void; disabled: boolean; busy: boolean };
  avatarHistory: ReactNode;
  feedback: ReactNode;
} | null>(null);

export function useSelfProfileFields() {
  return useContext(SelfProfileFieldsContext);
}

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
  renderValue?: (value: ReactNode) => ReactNode;
  inline?: boolean;
  valueHasAction?: boolean;
}) {
  const context = useSelfProfileFields();
  const editor = context?.fields[field];
  return editor ? cloneElement(editor, { renderValue, inline, valueHasAction }) : children;
}
