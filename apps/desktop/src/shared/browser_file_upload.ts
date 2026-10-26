/** 与聊天附件上限一致；传输分段，避免 JSON 请求一次膨胀整个文件。 */
export const BROWSER_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const BROWSER_FILE_CHUNK_BYTES = 1024 * 1024;
