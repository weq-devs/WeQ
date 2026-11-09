import type { GapFetchedMessage } from '@weq/service';
import type { ChatMsgWire } from './serde';

export function roamingMsgToWire(row: GapFetchedMessage): ChatMsgWire {
  const { nativeRaw: _nativeRaw, protocolRaw: _protocolRaw, ...wire } = row;
  return { ...wire, source: 'roaming', msgRandom: row.msgRandom ?? '' };
}
