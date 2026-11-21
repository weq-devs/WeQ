import { createContext } from 'react';
import type { Message } from '../im-template/template/types';
import '../styles/message-metadata.css';

export const ShowMessageSeqContext = createContext(false);
export const ShowMessageDateContext = createContext(false);
export const ShowMessageTimeContext = createContext(false);

export function messageSequence(seq: Message['msgSeq']) {
  return seq && /^\d+$/.test(seq) && BigInt(seq) > 0n ? seq : null;
}

export function showsRoamingSource(message: Pick<Message, 'source' | 'localSent' | 'recall'>) {
  return message.source === 'roaming' && !message.localSent && !message.recall?.retained;
}
