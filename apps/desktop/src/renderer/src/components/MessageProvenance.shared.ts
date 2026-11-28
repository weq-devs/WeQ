import { createContext } from 'react';
import type { Message } from '../im-template/template/types';
import '../styles/message-metadata.css';

export const ShowMessageSeqContext = createContext(false);
export const ShowMessageDateContext = createContext(false);
export const ShowMessageTimeContext = createContext(false);

export function messageSequence(seq: Message['msgSeq']) {
  return seq && /^\d+$/.test(seq) && BigInt(seq) > 0n ? seq : null;
}

export type MessageProvenanceSource = Pick<
  Message,
  'source' | 'localSent' | 'sentFromWeq' | 'livePush' | 'recall'
>;

export function showsRoamingSource(message: MessageProvenanceSource) {
  return (
    message.source === 'roaming' &&
    !message.localSent &&
    !message.sentFromWeq &&
    !message.livePush &&
    !message.recall?.retained
  );
}
