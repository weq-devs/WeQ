/**
 * qfile.qq.com 匿名 HTTP2RPC 客户端 —— 移植自 OpenList-QQ-Flash 的
 * internal/flash_transfer。三条接口：
 *
 *   - GetFileList            (0x93d4) 普通目录列表
 *   - GetCompressedFileFolder (0x9402) 压缩包内部目录列表
 *   - BatchDownload          (0x9248) 按 physicalId 换下载直链
 *
 * 全部是 noauth 接口，Cookie 用匿名 QQ UIN，不需要登录。列表接口带
 * pagination_info 分页（OpenList 只拉第一页 70 条，这里补全到 isEnd）。
 */
import { getLogger, logErrorContext } from '../../common/logger';
import type { FlashListFile } from './types';

const BASE_URL = 'https://qfile.qq.com';
/** 匿名 QQ UIN（OpenList 同款）。 */
const ANON_COOKIE = 'uin=9000002; p_uin=9000002;';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PAGE_SIZE = 70;
/** 分页安全上限，防止服务端不给 isEnd 导致死循环。 */
const MAX_PAGES = 200;

const logger = getLogger().child({ scope: 'flash-transfer-http' });

// ---- 原始响应结构（只声明用到的字段） -----------------------------------

interface RawFileEntry {
  name?: string;
  is_dir?: boolean;
  file_size?: string;
  file_physical_size?: string;
  srv_fileid?: string;
  srv_parent_fileid?: string;
  parent_id?: string;
  fileset_id?: string;
  cli_fileid?: string;
  file_sha1?: string;
  physical?: {
    id?: string;
    status?: number;
    is_unzipped?: boolean;
    url?: string;
  };
}

interface RawFileList {
  pagination_info?: string;
  parent_id?: string;
  is_end?: boolean;
  depth?: number;
  file_list?: RawFileEntry[];
}

interface RawListResponse {
  retcode?: number;
  message?: string;
  data?: { file_lists?: RawFileList[] };
}

interface RawDownloadResponse {
  retcode?: number;
  message?: string;
  data?: {
    download_rsp?: Array<{ url?: string; ret_code?: string; ret_msg?: string }>;
  };
}

// ---- 请求载荷 ------------------------------------------------------------

interface ReqInfo {
  parent_id: string;
  req_depth: number;
  count: number;
  pagination_info: string | null;
  filter_condition: { file_category: number };
  sort_conditions: Array<{ sort_field: number; sort_order: number }>;
}

interface FileFolderRequest {
  fileset_id: string;
  req_infos: ReqInfo[];
  support_folder_status: boolean;
  scene_type: number;
}

interface CompressedFolderRequest {
  fileset_id: string;
  cli_fileid: string;
  req_infos: Array<{ parent_id: string; req_depth: number; count: number }>;
  scene_type: number;
}

interface DownloadUrlRequest {
  req_head: { agent: number };
  download_info: Array<{
    batch_id: string;
    scene: { business_type: number; app_type: number; scene_type: number };
    index_node: { file_uuid: string };
    url_type: number;
    download_scene: number;
  }>;
  scene_type: number;
}

function parseSize(value: string | undefined): number {
  if (!value) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function mapFile(raw: RawFileEntry): FlashListFile {
  const physical = raw.physical ?? {};
  return {
    name: raw.name || '未知文件',
    isDir: raw.is_dir === true,
    fileSize: parseSize(raw.file_physical_size || raw.file_size),
    fileId: raw.srv_fileid || raw.cli_fileid || physical.id || '',
    parentId: raw.parent_id || raw.srv_parent_fileid || '',
    filesetId: raw.fileset_id || '',
    physicalId: physical.id || '',
    cliFileId: raw.cli_fileid || '',
    status: physical.status ?? 0,
    fileSha1: raw.file_sha1,
  };
}

function assertOk(body: { retcode?: number; message?: string }, what: string): void {
  if (body.retcode !== undefined && body.retcode !== 0) {
    throw new Error(`qfile ${what} retcode=${body.retcode} ${body.message ?? ''}`.trim());
  }
}

export class FlashTransferClient {
  private async post<T>(path: string, oidbCmd: string, payload: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ANON_COOKIE,
          'User-Agent': BROWSER_UA,
          'X-Oidb': oidbCmd,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      logger.error('qfile http request failed', {
        event: 'qfile-http',
        path,
        ...logErrorContext(error),
      });
      throw new Error(`请求 qfile 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) {
      throw new Error(`qfile HTTP ${res.status} ${res.statusText} (${path})`);
    }
    const text = await res.text();
    let json: T;
    try {
      json = JSON.parse(text) as T;
    } catch {
      throw new Error(`qfile 返回非 JSON（${path}）：${text.slice(0, 200)}`);
    }
    return json;
  }

  /** 拉取普通目录的完整文件列表（自动翻页到 isEnd）。 */
  async listFiles(filesetId: string, parentId: string): Promise<FlashListFile[]> {
    const out: FlashListFile[] = [];
    let pagination: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const payload: FileFolderRequest = {
        fileset_id: filesetId,
        req_infos: [
          {
            parent_id: parentId,
            req_depth: 1,
            count: PAGE_SIZE,
            pagination_info: pagination,
            filter_condition: { file_category: 0 },
            sort_conditions: [{ sort_field: 0, sort_order: 0 }],
          },
        ],
        support_folder_status: true,
        scene_type: 103,
      };
      const resp = await this.post<RawListResponse>(
        '/http2rpc/gotrpc/noauth/trpc.file.FileFlashTrans/GetFileList',
        '{"uint32_command":"0x93d4", "uint32_service_type":"1"}',
        payload,
      );
      assertOk(resp, 'GetFileList');
      const list = resp.data?.file_lists?.[0];
      if (!list) break;
      out.push(...(list.file_list ?? []).map(mapFile));
      if (list.is_end || !list.pagination_info) break;
      pagination = list.pagination_info;
    }
    return out;
  }

  /** 拉取压缩包内部目录的完整文件列表（自动翻页到 isEnd）。 */
  async listCompressedFiles(
    filesetId: string,
    cliFileId: string,
    parentId: string,
  ): Promise<FlashListFile[]> {
    const out: FlashListFile[] = [];
    let pagination: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const payload: CompressedFolderRequest = {
        fileset_id: filesetId,
        cli_fileid: cliFileId,
        req_infos: [
          {
            parent_id: parentId,
            req_depth: 1,
            count: PAGE_SIZE,
            ...(pagination ? { pagination_info: pagination } : {}),
          },
        ],
        scene_type: 103,
      };
      const resp = await this.post<RawListResponse>(
        '/http2rpc/gotrpc/noauth/trpc.file.flashtransfer.FlashTransferService/GetCompressedFileFolder',
        '{"uint32_command":"0x9402", "uint32_service_type":"1"}',
        payload,
      );
      assertOk(resp, 'GetCompressedFileFolder');
      const list = resp.data?.file_lists?.[0];
      if (!list) break;
      out.push(...(list.file_list ?? []).map(mapFile));
      if (list.is_end || !list.pagination_info) break;
      pagination = list.pagination_info;
    }
    return out;
  }

  /** 按 physicalId 换下载直链（batchId 与 fileUuid 都用 physicalId，OpenList 同款）。 */
  async getDownloadUrl(physicalId: string): Promise<string> {
    const payload: DownloadUrlRequest = {
      req_head: { agent: 8 },
      download_info: [
        {
          batch_id: physicalId,
          scene: { business_type: 4, app_type: 22, scene_type: 5 },
          index_node: { file_uuid: physicalId },
          url_type: 2,
          download_scene: 0,
        },
      ],
      scene_type: 103,
    };
    const resp = await this.post<RawDownloadResponse>(
      '/http2rpc/gotrpc/noauth/trpc.qqntv2.richmedia.InnerProxy/BatchDownload',
      '{"uint32_command":"0x9248", "uint32_service_type":"4"}',
      payload,
    );
    assertOk(resp, 'BatchDownload');
    const url = resp.data?.download_rsp?.[0]?.url;
    if (!url) {
      throw new Error('BatchDownload 未返回下载地址');
    }
    return url.startsWith('http://') ? url.replace('http://', 'https://') : url;
  }
}
