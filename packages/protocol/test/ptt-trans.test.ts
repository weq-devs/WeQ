/**
 * 语音在线转写（pttTrans）离线单测 —— 用 `~/Downloads/{c2cptt,groupptt}.log`
 * 的真实抓包向量锁定字段布局：
 *   - 请求 decode → 期望字段；
 *   - decode → encode 逐字节等于抓包原文；
 *   - 用 builder 构造同样逐字节一致；
 *   - 同步响应 ack 的 errCode；
 *   - MsgPush（msgType 528 / subType 61）里按 msgId 归集出转写文本。
 *
 * 任何字段编号 / 类型 / force 改动都会立刻把这些黄金字节打红。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import {
  buildPttTransReq,
  C2C_PTT_TRANS_CMD,
  encodePttTransReq,
  GROUP_PTT_TRANS_CMD,
  parsePttTransAck,
  parsePttTransPush,
  PTT_TRANS_REQ,
  PTT_TRANS_PUSH_MSG_TYPE,
  PTT_TRANS_PUSH_SUB_TYPE,
  pttTransCmd,
  type PttTransVoice,
} from '../src/ptt-trans';
import { C2C_PUSH, C2C_RESP, C2C_SEND, GRP_PUSH, GRP_RESP, GRP_SEND } from './ptt-trans.vectors';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));

const C2C_VOICE: PttTransVoice = {
  isGroup: false,
  msgId: '7693708445409892945',
  senderUin: '1707889225',
  peerUin: '3433285587',
  uuid: 'EhSVqh05GohqEfLVrnpmveyKOLygzRiEQSD6CijTovSpzKaXAzIEcHJvZFCA9SRaECcCC0RQx7LztqfPoNom-hZ6AiJPggECZ3o',
  md5: 'f49899cf77757483f096e340b62ec644',
  duration: 5,
  size: 8324,
  format: 1,
  eventType: 0,
};

const GRP_VOICE: PttTransVoice = {
  isGroup: true,
  msgId: '7693712293026052364',
  senderUin: '1707889225',
  peerUin: '673646675',
  uuid: 'EhSs6d0VnWplDq2erwekd-zmp6_LGBixfCD7Cij4_ozVz6aXAzIEcHJvZFCA9SRaELOenUVaKzcW3wuw6EhiGh56AvCxggECZ3o',
  md5: '2c1378d14bcc293fa0076d421d313470',
  duration: 10,
  size: 15921,
  format: 1,
  eventType: 0,
};

describe('pttTrans 请求', () => {
  it('c2c：decode 出的字段符合抓包', () => {
    const obj = decode(PTT_TRANS_REQ, unhex(C2C_SEND)) as any;
    expect(obj.type).toBe(2);
    expect(obj.c2cItem.msgId).toBe(7693708445409892945n);
    expect(obj.c2cItem.senderUin).toBe(1707889225n);
    expect(obj.c2cItem.receiverUin).toBe(3433285587n);
    expect(obj.c2cItem.uuid).toBe(C2C_VOICE.uuid);
    expect(obj.c2cItem.duration).toBe(5);
    expect(obj.c2cItem.size).toBe(8324);
    expect(obj.c2cItem.format).toBe(1);
    expect(obj.c2cItem.eventType).toBe(0);
    expect(obj.c2cItem.md5).toBe('f49899cf77757483f096e340b62ec644');
    expect(obj.flag5).toBe(1);
    expect(obj.flag6).toBe(1);
    expect(obj.flag10).toBe(0);
  });

  it('c2c：decode → encode 逐字节一致', () => {
    const obj = decode(PTT_TRANS_REQ, unhex(C2C_SEND));
    expect(hex(encode(PTT_TRANS_REQ, obj))).toBe(C2C_SEND);
  });

  it('c2c：builder 构造逐字节一致', () => {
    expect(hex(encodePttTransReq(C2C_VOICE))).toBe(C2C_SEND);
    expect(hex(encode(PTT_TRANS_REQ, buildPttTransReq(C2C_VOICE)))).toBe(C2C_SEND);
  });

  it('group：decode → encode 逐字节一致 + builder 一致', () => {
    const obj = decode(PTT_TRANS_REQ, unhex(GRP_SEND)) as any;
    expect(obj.type).toBe(1);
    expect(obj.groupItem.msgId).toBe(7693712293026052364n);
    expect(obj.groupItem.groupUin).toBe(673646675n);
    expect(obj.groupItem.fileId).toBe(0);
    expect(obj.groupItem.md5).toBe('2c1378d14bcc293fa0076d421d313470');
    expect(obj.groupItem.duration).toBe(10);
    expect(obj.groupItem.size).toBe(15921);
    expect(obj.groupItem.uuid).toBe(GRP_VOICE.uuid);
    expect(hex(encode(PTT_TRANS_REQ, obj))).toBe(GRP_SEND);
    expect(hex(encodePttTransReq(GRP_VOICE))).toBe(GRP_SEND);
  });

  it('命令名按场景选取', () => {
    expect(pttTransCmd(false)).toBe(C2C_PTT_TRANS_CMD);
    expect(pttTransCmd(true)).toBe(GROUP_PTT_TRANS_CMD);
  });
});

describe('pttTrans 同步 ack', () => {
  it('c2c：errCode 0、msgId 回带', () => {
    expect(parsePttTransAck(unhex(C2C_RESP), false)).toEqual({
      msgId: 7693708445409892945n,
      errCode: 0,
    });
  });
  it('group：errCode 0、msgId 回带', () => {
    expect(parsePttTransAck(unhex(GRP_RESP), true)).toEqual({
      msgId: 7693712293026052364n,
      errCode: 0,
    });
  });
});

describe('pttTrans push', () => {
  it('常量正确', () => {
    expect(PTT_TRANS_PUSH_MSG_TYPE).toBe(528);
    expect(PTT_TRANS_PUSH_SUB_TYPE).toBe(61);
  });

  it('c2c：msgId 与请求一致、文本正确', () => {
    const push = parsePttTransPush(unhex(C2C_PUSH));
    expect(push).not.toBeNull();
    expect(push!.msgId).toBe(7693708445409892945n);
    expect(push!.text).toBe('一二三四五六七八九十。');
    expect(push!.senderUin).toBe(1707889225n);
    expect(push!.receiverUin).toBe(3433285587n);
  });

  it('group：msgId 与请求一致、文本正确', () => {
    const push = parsePttTransPush(unhex(GRP_PUSH));
    expect(push).not.toBeNull();
    expect(push!.msgId).toBe(7693712293026052364n);
    expect(push!.text).toBe('十九八七六五四三二一。');
    expect(push!.senderUin).toBe(1707889225n);
    expect(push!.receiverUin).toBe(673646675n);
  });

  it('普通消息 push 返回 null', () => {
    // 把 contentHead.msgType 改掉：从 0x9004 起的那段不在，用一段空 body 兜底。
    expect(parsePttTransPush(new Uint8Array(0))).toBeNull();
  });
});
