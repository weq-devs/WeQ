/** 字节载荷的暂存上限；设备 File 走分片读取，使用独立上限。 */
export const BROWSER_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const PICKED_BROWSER_FILE_MAX_BYTES = 2 * 1024 ** 3;
export const BROWSER_FILE_CHUNK_BYTES = 1024 * 1024;
