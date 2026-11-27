import { createContext } from 'react';

export const TaskResultNavigationContext = createContext<{
  dismiss: () => void;
  openCalendar?: (id: string) => Promise<boolean>;
  openAnalysisReport?: (id: string) => Promise<boolean>;
} | null>(null);
