import { createContext, useContext } from 'react';

export const TabActivityContext = createContext(true);
export const useTabActive = () => useContext(TabActivityContext);
