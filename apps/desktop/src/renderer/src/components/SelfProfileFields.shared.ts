import {
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
  | 'personalityLabels'
  | 'anonymousQuestions';
export type SelfProfileFields = Partial<
  Record<SelfProfileKey, ReactElement<ComponentProps<typeof SelfProfileField>>>
>;
export const SelfProfileFieldsContext = createContext<{
  fields: SelfProfileFields;
  uin: string;
  feedback: ReactNode;
} | null>(null);

export function useSelfProfileFields() {
  return useContext(SelfProfileFieldsContext);
}
