/**
 * SendAiVoice (0x929b_0) 的离线单元测试：请求编码（黄金字节）+ 响应解析。
 *
 * 黄金字节按真机抓包 + 服务端错误回显反推的字段布局（见 src/oidb/send-ai-voice.ts）：
 *   - 请求字段顺序 1(group_code),2(voice_id),3(text),4(chat_type),5(client_msg_info{1:msg_random})
 *   - 响应 1(ret_code)=1 / 3(field3)=20 / 4(audio)
 *
 * 同时钉住「只支持群聊」这一实测结论：私聊目标的失败模式有两个（31001 / 70001），
 * 用注释记录，不做网络断言。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { SendAiVoice } from '../src/index';
import type { SendAiVoiceParams } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .replace(/\s+/g, '')
      .match(/../g)!
      .map((h) => Number.parseInt(h, 16)),
  );

const GROUP = 673646675;
const VOICE_ID = 'lucy-voice-suxinjiejie';
const TEXT = '喵喵喵';
const MSG_RANDOM = 1661829644;

const PARAMS: SendAiVoiceParams = {
  groupCode: GROUP,
  voiceId: VOICE_ID,
  text: TEXT,
  msgRandom: MSG_RANDOM,
};

/**
 * 真机抓到的请求内层 body（用户原始 hex，剥离 4B 长度头与 OIDB 信封后）。
 * 与 SendAiVoice.serialize 的输出逐字节一致（同一 msgRandom）。
 */
const GOLDEN_REQ = hexToBytes(`
  08d3909cc102 12166c7563792d766f6963652d737578696e6a69656a6965
  1a09e596b5e596b5e596b5 2001 2a06088c84b69806
`);

/** 真机回复的内层 body（一次成功合成，uid=1707889225 的账号）。 */
const GOLDEN_RESP = hexToBytes(`
  0801181422a2020af8010af5010a7f08831f12206164626630373930363337613039353539633934
  6533353762666134653237611a2830306237613433666335363563663532363761306337656435
  323165663364376534383835333462222461646266303739303633376130393535396339346533
  353762666134653237612e616d722a0408032001400148011263456851417436515f7857585055
  6d6567782d315348765058354968545378694448794437436969327874504e6c497158417a4945
  63484a765a46434139535261454c3434664653374b645244416c624272455861466b4a36416c6e
  50676745435a336f1801208ac5dad5062880f52438fb0a12251a2108c9a4b1ae0610022a13080f12
  0f0000fef3bc7c89776f846a04000000620248015003
`);

describe('SendAiVoice (0x929b_0)', () => {
  it('declares command 0x929b sub 0 (SSO: OidbSvcTrpcTcp.0x929b_0)', () => {
    expect(SendAiVoice.command).toBe(0x929b);
    expect(SendAiVoice.subCommand).toBe(0);
  });

  it('encodes the request exactly like the captured packet', () => {
    const bytes = encode(SendAiVoice.reqSchema, SendAiVoice.serialize(PARAMS));
    expect(bytes).toEqual(GOLDEN_REQ);
  });

  it('defaults chatType to 1 (群聊) and f5 msgRandom 随机填充', () => {
    const body = derivebody(
      SendAiVoice.serialize({ groupCode: GROUP, voiceId: VOICE_ID, text: TEXT }),
    );
    expect(body.chatType).toBe(1);
    expect((body.clientMsgInfo as { msgRandom: number }).msgRandom).toBeGreaterThanOrEqual(0);
  });

  it('parses a real successful reply (retCode=1/f3=20/.amr 索引)', () => {
    const result = SendAiVoice.deserialize(decode(SendAiVoice.respSchema, GOLDEN_RESP));
    expect(result.retCode).toBe(1);
    expect(result.field3).toBe(20);
    expect(SendAiVoice.isOk(result)).toBe(true);
    const info = result.audio?.node?.fileInfo;
    expect(info?.fileName).toBe('adbf0790637a09559c94e357bfa4e27a.amr');
    expect(info?.fileHash).toBe('adbf0790637a09559c94e357bfa4e27a');
    expect(info?.fileSha1).toBe('00b7a43fc565cf5267a0c7ed521ef3d7e488534b');
    expect(info?.type.type).toBe(3);
    expect(info?.type.voiceFormat).toBe(1);
    expect(info?.fileSize).toBe(3971);
    expect(info?.original).toBe(1);
    expect(result.audio?.node?.ttlSeconds).toBe(604800);
    expect(result.audio?.node?.uploadTime).toBe(1790354058);
    expect(result.audio?.node?.field3).toBe(1);
    expect(result.audio?.node?.field7).toBe(1403);
    expect(result.audio?.node?.urlParam.length).toBe(99);
    expect(result.audio?.senderUin).toBe(1707889225);
  });

  it('round-trips serialize → decode (字段名稳定)', () => {
    const bytes = encode(SendAiVoice.reqSchema, SendAiVoice.serialize(PARAMS));
    const body = decode(SendAiVoice.reqSchema, bytes);
    expect(body).toEqual({
      // uint64 解码为 bigint（与 send_msg 测试同一约定）
      groupCode: BigInt(GROUP),
      voiceId: VOICE_ID,
      text: TEXT,
      chatType: 1,
      clientMsgInfo: { msgRandom: MSG_RANDOM },
    });
  });

  // 私聊不支持：见 src/oidb/send-ai-voice.ts 文件头。两个失败码分别是
  // 31001 (GenerateAudio err) 和 70001 (AudioRsp MediaData is Empty)，
  // 且服务端 dump 会显示 uid 字段退化成未命名字段 1:"u_…"。
  it.todo('私聊目标（uin/uid）服务端拒收：31001 / 70001（需要注入的 QQ 环境）');
});

/** 小工具：把 serialize 的结果喂给 schema 编解码，便于断言缺省值。 */
function derivebody(serialized: Record<string, unknown>): Record<string, unknown> {
  return decode(SendAiVoice.reqSchema, encode(SendAiVoice.reqSchema, serialized));
}
