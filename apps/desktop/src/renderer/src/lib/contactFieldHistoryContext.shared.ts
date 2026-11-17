import { createContext } from 'react';

export const ContactFieldHistoryContext = createContext<{
  entity: string;
  memberUid?: string;
  fields: string[];
} | null>(null);
