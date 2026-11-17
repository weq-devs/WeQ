import { createContext } from 'react';
import '../styles/profile-field-editor.css';

/** 内容控件留在值列，提交按钮投到该字段唯一的操作组。 */
export const ProfileFieldEditorContext = createContext<{
  target: HTMLSpanElement | null;
  disabled: boolean;
} | null>(null);
