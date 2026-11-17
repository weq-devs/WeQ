import { createContext, useContext } from 'react';
import '../styles/self-profile-card.css';

export type Save = (action: () => Promise<boolean>) => Promise<boolean>;
const saveContext = createContext<Save>((action) => action());
export const SelfProfileEditingContext = createContext(true);
export const useSelfProfileSave = () => useContext(saveContext);

export { saveContext as SaveContext };
