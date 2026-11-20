import { createContext, useContext } from 'react';
import '../styles/friend-directory.css';

type Category = { id: number; name: string; buddyCount: number | null; sortOrder: number | null };
export const FriendDirectoryContext = createContext<{
  categories: Category[] | null;
  assignments: Map<string, number>;
  busy: boolean;
  available: boolean;
  error?: string;
  retry?: () => void;
  openOnlineDirectory?: () => void;
  create: () => void;
  edit: (type: 'rename' | 'delete', id: number) => void;
  move: (uids: string[], categoryId?: number) => void;
  sort: (id: number, target: number | 'first' | 'last', position?: 'before' | 'after') => void;
} | null>(null);

export const useFriendDirectory = () => useContext(FriendDirectoryContext);
