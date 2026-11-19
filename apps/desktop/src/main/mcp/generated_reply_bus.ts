import { EventEmitter } from 'node:events';
import type { GeneratedReply } from '../../shared/generated_reply';

export const generatedReplyBus = new EventEmitter().setMaxListeners(50);

export function publishGeneratedReply(configId: string | undefined, reply: GeneratedReply) {
  if (configId) generatedReplyBus.emit('reply', configId, reply);
}
