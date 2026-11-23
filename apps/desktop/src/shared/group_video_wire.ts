import {
  GROUP_VIDEO_UPLOAD_MAX_BYTES,
  type GroupVideoDelivery,
  type GroupVideoFrame,
} from './call_video_ipc';

export const GROUP_VIDEO_WEB_PATH = '/group-call-video';
const UPLOAD_HEADER = 5;
const DOWNLINK_HEADER = 9;
export const GROUP_VIDEO_WEB_MAX_INBOUND = UPLOAD_HEADER + 2 * GROUP_VIDEO_UPLOAD_MAX_BYTES;

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function encodeGroupVideoUpload({ data, secondary, keyframe }: GroupVideoFrame) {
  const bytes = new Uint8Array(UPLOAD_HEADER + data.length + secondary.length);
  bytes[0] = Number(keyframe);
  view(bytes).setUint32(1, data.length);
  bytes.set(data, UPLOAD_HEADER);
  bytes.set(secondary, UPLOAD_HEADER + data.length);
  return bytes;
}

export function decodeGroupVideoUpload(bytes: Uint8Array) {
  if (bytes.length <= UPLOAD_HEADER || bytes[0]! > 1) return;
  const length = view(bytes).getUint32(1);
  const secondary = bytes.length - UPLOAD_HEADER - length;
  if (
    length < 1 ||
    length > GROUP_VIDEO_UPLOAD_MAX_BYTES ||
    secondary < 1 ||
    secondary > GROUP_VIDEO_UPLOAD_MAX_BYTES
  )
    return;
  const boundary = UPLOAD_HEADER + length;
  return {
    data: bytes.subarray(UPLOAD_HEADER, boundary),
    secondary: bytes.subarray(boundary),
    keyframe: bytes[0] === 1,
  };
}

export function encodeGroupVideoDelivery(seq: number, { uin, data, keyframe }: GroupVideoDelivery) {
  const bytes = new Uint8Array(DOWNLINK_HEADER + data.length);
  const header = view(bytes);
  header.setUint32(0, seq);
  header.setUint32(4, uin);
  bytes[8] = Number(keyframe);
  bytes.set(data, DOWNLINK_HEADER);
  return bytes;
}

export function decodeGroupVideoDelivery(bytes: Uint8Array) {
  if (bytes.length <= DOWNLINK_HEADER || bytes[8]! > 1) return;
  const header = view(bytes);
  return {
    seq: header.getUint32(0),
    frame: {
      uin: header.getUint32(4),
      data: bytes.subarray(DOWNLINK_HEADER),
      keyframe: bytes[8] === 1,
    },
  };
}

// 上行视频以长度区分帧与确认。下行的一字节消息是上行处理回执。
export function groupVideoAck(seq: number) {
  const bytes = new Uint8Array(4);
  view(bytes).setUint32(0, seq);
  return bytes;
}

export function readGroupVideoAck(bytes: Uint8Array) {
  return bytes.length === 4 ? view(bytes).getUint32(0) : undefined;
}
