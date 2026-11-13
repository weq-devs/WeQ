import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Row } from './settings/controls';
import '../styles/profile-field-editor.css';

/** 内容控件留在值列，提交按钮投到该字段唯一的操作组。 */
export const ProfileFieldEditorContext = createContext<{
  target: HTMLSpanElement | null;
  disabled: boolean;
} | null>(null);

export function ProfileEditorRow({ label, control }: { label: ReactNode; control: ReactNode }) {
  return useContext(ProfileFieldEditorContext) ? control : <Row label={label} control={control} />;
}

export function ProfileEditorAction({ children }: { children: ReactNode }) {
  const context = useContext(ProfileFieldEditorContext);
  return context ? (context.target ? createPortal(children, context.target) : null) : children;
}
