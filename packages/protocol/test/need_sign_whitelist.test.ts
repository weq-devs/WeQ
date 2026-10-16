/**
 * 签名白名单对齐回归测试。
 *
 * `invokeOidb` / `invokeTrpc` 的 `needSign` 缺省是 `true`（保守），所以 spec
 * 一旦漏标就会默默带上 `SecToken/SecExtra/SecSign`。这些命令经核对都不在
 * LagrangeV2 的签名白名单里（白名单见 `Lagrange.Core/Common/BotSignProvider.cs`），
 * 必须显式 `needSign = false`，否则会平白多签一批包。
 *
 * 覆盖 12 个导出的 OIDB spec + 3 个 trpc spec。私有的 `UploadGroupFile`
 * (0x6D6_0) 在 `file_send.test.ts` 里从路由侧断言。
 */

import { describe, expect, it } from 'vitest';
import {
  ApplyFileset,
  ApplyUpload,
  CommitFile,
  CompleteFileset,
  FetchDownloadRkeys,
  GetAlbumMediaList,
  GetC2cHistory,
  GetFilesetDetail,
  GetGroupHistory,
  GetProfileLike,
  GetQqShowUrl,
  ListGroupFiles,
  PrepareUpload,
  SendPoke,
  SetFilesetStatus,
} from '../src/index';

/** [spec 名, 命令号（OIDB）或命令串（trpc）, needSign=false 的理由] */
const CASES: [string, { needSign?: boolean }, string][] = [
  ['ListGroupFiles', ListGroupFiles, 'OidbSvcTrpcTcp.0x6d8_1 不在白名单'],
  ['GetProfileLike', GetProfileLike, 'OidbSvcTrpcTcp.0x7ed_12 不在白名单'],
  ['SendPoke', SendPoke, 'OidbSvcTrpcTcp.0xed3_1 不在白名单'],
  ['GetQqShowUrl', GetQqShowUrl, 'OidbSvcTrpcTcp.0xfe1_3 不在白名单'],
  ['FetchDownloadRkeys', FetchDownloadRkeys, 'OidbSvcTrpcTcp.0x9067_202 不在白名单'],
  ['PrepareUpload', PrepareUpload, 'OidbSvcTrpcTcp.0x12a9_100 不在白名单'],
  ['ApplyUpload', ApplyUpload, 'OidbSvcTrpcTcp.0x12a9_103 不在白名单'],
  ['ApplyFileset', ApplyFileset, 'OidbSvcTrpcTcp.0x93cf_1 不在白名单'],
  ['CommitFile', CommitFile, 'OidbSvcTrpcTcp.0x93d0_1 不在白名单'],
  ['SetFilesetStatus', SetFilesetStatus, 'OidbSvcTrpcTcp.0x93d1_1 不在白名单'],
  ['GetFilesetDetail', GetFilesetDetail, 'OidbSvcTrpcTcp.0x93d3_1 不在白名单'],
  ['CompleteFileset', CompleteFileset, 'OidbSvcTrpcTcp.0x93db_1 不在白名单'],
  ['GetGroupHistory', GetGroupHistory, 'SsoGetGroupMsg 不在白名单'],
  ['GetC2cHistory', GetC2cHistory, 'SsoGetC2cMsg 不在白名单'],
  ['GetAlbumMediaList', GetAlbumMediaList, 'QunMedia.GetMediaList 不在白名单'],
];

describe('签名白名单：不在白名单的命令显式关签名', () => {
  for (const [name, spec, reason] of CASES) {
    it(`${name}：needSign === false（${reason}）`, () => {
      expect(spec.needSign).toBe(false);
    });
  }
});
