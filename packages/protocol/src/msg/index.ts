export { GetGroupHistory, GetC2cHistory, fetchGroupHistoryRaw, fetchC2cHistoryRaw } from './get-history';
export type { GroupHistoryParams, C2cHistoryParams, HistoryFetchResult } from './get-history';
export { SSO_GET_GROUP_MSG_CMD, SSO_GET_C2C_MSG_CMD } from './get-history';

export { decodeMessage } from './decode';
export type { DecodedMessage, DecodedDress } from './decode';

export { dumpProto, walkProto, extractPath, protoToJson } from './dump';
export type { DumpOptions, DumpEntry, PathStep, ProtoJsonMap, ProtoJsonNode, ProtoJsonLeaf } from './dump';

export {
  PUSH_MSG_BODY, PUSH_MSG, RESPONSE_HEAD, CONTENT_HEAD, MESSAGE_BODY, RICH_TEXT, ELEM,
  TEXT_ELEM, TEXT_PB_RESERVE, FACE_ELEM, PIC_COMMON_PB, PTT_COMMON_PB, VIDEO_COMMON_PB, FILE_TRANS_TOP, MARKDOWN_COMMON_PB, INLINE_KEYBOARD_PB, NOT_ONLINE_IMAGE, MARKET_FACE, CUSTOM_FACE, TRANS_ELEM,
  GROUP_FILE_ELEM, EXTRA_INFO, VIDEO_FILE, GENERAL_FLAGS, REPLY_ELEMENT, REPLY_PB_RESERVE, LIGHT_APP_ELEM, WALLET_ELEM,
  COMMON_ELEM, RICH_MSG, NOT_ONLINE_FILE, PTT, ONLINE_IMAGE,
  FONT_INFO, BUBBLE_ELEM,
} from './schemas';
