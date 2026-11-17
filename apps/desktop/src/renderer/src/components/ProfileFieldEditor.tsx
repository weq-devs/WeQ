import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Row } from './settings/controls';
import '../styles/profile-field-editor.css';
import { ProfileFieldEditorContext } from './ProfileFieldEditor.shared';

export function ProfileEditorRow({ label, control }: { label: ReactNode; control: ReactNode }) {
  return useContext(ProfileFieldEditorContext) ? control : <Row label={label} control={control} />;
}

export function ProfileEditorAction({ children }: { children: ReactNode }) {
  const context = useContext(ProfileFieldEditorContext);
  return context ? (context.target ? createPortal(children, context.target) : null) : children;
}
