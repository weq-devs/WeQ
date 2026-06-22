/**
 * ChatLab JSONL format type definitions.
 * Spec: https://github.com/openchatlab/chatlab/packages/parser/src/formats/chatlab-jsonl.ts
 */

/** ChatLab message type enum (matches @openchatlab/shared-types) */
export enum ChatlabMessageType {
  TEXT = 0,
  IMAGE = 1,
  VOICE = 2,
  VIDEO = 3,
  FILE = 4,
  EMOJI = 5,
  LINK = 7,
  LOCATION = 8,
  RED_PACKET = 20,
  TRANSFER = 21,
  POKE = 22,
  CALL = 23,
  SHARE = 24,
  REPLY = 25,
  FORWARD = 26,
  CONTACT = 27,
  SYSTEM = 80,
  RECALL = 81,
  OTHER = 99,
}

/** JSONL header line */
export interface ChatlabHeader {
  _type: 'header';
  chatlab: {
    version: string;
    exportedAt: number;
    generator: string;
  };
  meta: {
    name: string;
    platform: string;
    type: 'group' | 'private';
    groupId?: string;
    groupAvatar?: string;
    ownerId?: string;
  };
}

/** JSONL member line */
export interface ChatlabMember {
  _type: 'member';
  platformId: string;
  accountName: string;
  groupNickname?: string;
  avatar?: string;
}

/** JSONL message line */
export interface ChatlabMessage {
  _type: 'message';
  sender: string;
  platformMessageId?: string;
  accountName: string;
  groupNickname?: string;
  timestamp: number;
  type: number;
  content: string | null;
  replyToMessageId?: string;
}
