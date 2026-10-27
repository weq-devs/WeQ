/** 与版本同步脚本共用标签输入契约；这里只校验输入，不实现版本排序。 */
export function versionInput(raw) {
  const version = typeof raw === 'string' ? raw.replace(/^v/i, '') : '';
  return /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : null;
}
