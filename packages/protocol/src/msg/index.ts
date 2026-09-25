export {
  GetGroupHistory,
  GetC2cHistory,
  fetchGroupHistoryRaw,
  fetchC2cHistoryRaw,
} from './get-history';
export type { GroupHistoryParams, C2cHistoryParams, HistoryFetchResult } from './get-history';
export { SSO_GET_GROUP_MSG_CMD, SSO_GET_C2C_MSG_CMD } from './get-history';

export { decodeMessage } from './decode';
export type { DecodedMessage, DecodedDress } from './decode';

export {
  buildSendElems,
  buildSendElemsWithMedia,
  buildDressElems,
  deflatePayload,
  isSendMediaElement,
} from './send-elements';
export type {
  MediaSendContext,
  SendDress,
  SendMediaElement,
  SendImageElement,
  SendRecordElement,
  SendVideoElement,
  SendElement,
  SendTextElement,
  SendAtElement,
  SendFaceElement,
  SendSuperSticker,
  SendMfaceElement,
  SendReplyElement,
  SendArkElement,
  SendXmlElement,
  SendMarkdownElement,
  SendPokeElement,
  SendEmojiBounceElement,
  SendForwardElement,
  SendRawElement,
  SendMediaUploadReport,
  SendScene,
} from './send-elements';

export {
  buildSendRequest,
  buildSendRequestBytes,
  buildSendRequestWithMedia,
  isSendOk,
  nextClientSequence,
  parseSendResponse,
  sendC2cMessage,
  sendGroupMessage,
  sendGroupTempMessage,
  sendMessage,
  SEND_MSG_CMD,
  SendMsg,
} from './send';
export type {
  SendGroupTempTarget,
  SendMessageParams,
  SendMessageReceipt,
  SendMessageResponseInfo,
  SendRequestBuild,
} from './send';

export {
  MESSAGE_CONTROL,
  EMOJI_BOUNCE_DETAIL,
  EMOJI_BOUNCE_EXTRA,
  POKE_EXTRA,
  QFACE_EXTRA,
  QSMALL_FACE_EXTRA,
  ROUTING_C2C,
  ROUTING_GROUP,
  ROUTING_GROUP_TEMP,
  ROUTING_HEAD,
  ROUTING_TRANS_0X211,
  SEND_CONTENT_HEAD,
  SEND_MESSAGE_BODY,
  SEND_MESSAGE_REQUEST,
  SEND_MESSAGE_RESPONSE,
  SEND_RICH_TEXT,
  MARKET_FACE_PB_RESERVE,
} from './send-schemas';

export { RecvLongMsg, fetchForwardRaw, SSO_RECV_LONG_MSG_CMD } from './get-forward';
export type { RecvLongMsgParams, ForwardFetchResult } from './get-forward';
export {
  LONG_MSG_UID,
  LONG_MSG_SETTINGS,
  RECV_LONG_MSG_INFO,
  RECV_LONG_MSG_REQ,
  RECV_LONG_MSG_RESP_RESULT,
  RECV_LONG_MSG_RESP,
  LONG_MSG_CONTENT,
  LONG_MSG_ACTION,
  LONG_MSG_RESULT,
} from './get-forward';

export { dumpProto, walkProto, extractPath, protoToJson } from './dump';
export type {
  DumpOptions,
  DumpEntry,
  PathStep,
  ProtoJsonMap,
  ProtoJsonNode,
  ProtoJsonLeaf,
} from './dump';

export {
  PUSH_MSG_BODY,
  PUSH_MSG,
  RESPONSE_HEAD,
  CONTENT_HEAD,
  MESSAGE_BODY,
  MSG_CONTENT,
  RICH_TEXT,
  ELEM,
  TEXT_ELEM,
  TEXT_PB_RESERVE,
  FACE_ELEM,
  FACE_OLD_PB,
  FACE_COMMON_PB,
  PIC_COMMON_PB,
  PTT_COMMON_PB,
  VIDEO_COMMON_PB,
  FILE_TRANS_TOP,
  MARKDOWN_COMMON_PB,
  INLINE_KEYBOARD_PB,
  NOT_ONLINE_IMAGE,
  MARKET_FACE,
  CUSTOM_FACE,
  TRANS_ELEM,
  GROUP_FILE_ELEM,
  EXTRA_INFO,
  VIDEO_FILE,
  GENERAL_FLAGS,
  REPLY_ELEMENT,
  REPLY_PB_RESERVE,
  LIGHT_APP_ELEM,
  WALLET_ELEM,
  COMMON_ELEM,
  RICH_MSG,
  NOT_ONLINE_FILE,
  PTT,
  ONLINE_IMAGE,
  FONT_INFO,
  BUBBLE_ELEM,
} from './schemas';
