import { createContext } from 'react';
import type { ChatImageCache } from '../lib/chatImageCache';

export const ChatImageCacheContext = createContext<ChatImageCache | null>(null);
