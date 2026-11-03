/**
 * 权限助手（私有仓 `nt_helper` 里的 `weq-authorization-helper`）报错的用户向文案。
 *
 * 为什么 WeQ 这一侧要管这件事：助手的源码不公开，它的 `stderr` 是一句句英文
 * `bail!`，经 `authorization:install` 抛到渲染层就变成
 * `Error invoking remote method 'authorization:install': Error: installation directory is
 * not system-protected: /opt`。用户既看不出发生了什么，也不知道自己要做什么。
 *
 * 所以这里按**报错里稳定的英文片段**做映射，输出「结论 + 用户能照做的一步」。
 * 只认固定片段（会变的路径 / 服务名一律从报错里取，不硬编码猜），对不上就原样
 * 返回，绝不吞掉真实报错。
 */

export interface AuthorizationFailure {
  /** 给用户看的完整说明（可能多行，渲染层按 `pre-wrap` 保留换行与缩进）。 */
  message: string;
  /** 是否需要用户自己去命令行处理（设置页用警告色）。 */
  needsUserAction: boolean;
}

/** 提取 `Error invoking remote method '<channel>': Error: <detail>` 里的真实 detail。 */
export function unwrapIpcError(raw: string): string {
  const trimmed = raw.trim();
  const match = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

const NOT_PROTECTED = /installation directory is not system-protected:\s*(\S+)/;

/** 把一次安装 / 撤销失败的原始报错翻成用户能看懂的说明。 */
export function authorizationFailure(
  raw: string,
  context: { development?: boolean; operation?: 'install' | 'remove' } = {},
): AuthorizationFailure {
  const detail = unwrapIpcError(raw);
  const withDetail = (message: string, needsUserAction = false): AuthorizationFailure => ({
    message: `${message}\n\n原始报错：${detail}`,
    needsUserAction,
  });
  const removing = context.operation === 'remove';

  const notProtected = NOT_PROTECTED.exec(detail);
  if (notProtected) {
    const path = notProtected[1];
    const lines = [
      '长期授权要把一个小型权限助手注册成系统服务，所以安装目录必须由 root 拥有、且其他用户不可写。',
      `当前 ${path} 不满足这个条件（常见于重装系统 / 从备份恢复后目录属主变成了当前用户），` +
        'WeQ 拒绝在这种目录里安装以 root 运行的服务。',
      '',
      '请先在终端里执行这一条（WeQ 不会替你改系统目录，否则又变成普通用户可写）：',
      `  sudo chown root:root ${path}`,
      '',
      removing
        ? '执行后回到这里点「重新检查」，再点「撤销授权」。'
        : '再回到这里点「重新检查」，然后点「启用长期授权」。',
    ];
    // 开发通道只碰 /opt/weq-authorization-dev，别让用户误以为要动正式版目录。
    if (context.development === true)
      lines.push('（开发通道只影响独立开发助手的目录，不碰正式版的 /opt/weq-authorization。）');
    return withDetail(lines.join('\n'), true);
  }

  if (detail.includes('installation path is not a directory'))
    return withDetail(
      '安装位置被同名的普通文件占住了，无法创建权限助手目录。\n' +
        '请检查安装目录的上级路径（Linux 为 /opt，macOS 为 /Library/PrivilegedHelperTools）下是否有多出来的同名文件，' +
        '确认不是别的东西后删除再重试。',
      true,
    );

  if (detail.includes('long-term authorization requires systemd'))
    return withDetail(
      '长期授权依赖 systemd，而当前系统没有运行中的 systemd，因此无法注册权限助手服务。\n' +
        '临时授权不受影响，仍可使用；要继续使用长期授权需要由 systemd 引导的系统。',
      true,
    );

  if (detail.includes('another authorization installation is in progress'))
    return withDetail(
      '另一个长期授权操作正在进行（可能来自另一个 WeQ 窗口，或终端里手动运行的助手）。\n' +
        '等它完成后再点「重新检查」；确认没有别的操作卡住时，重新打开 WeQ 再试。',
    );

  if (detail.includes('helper changed before installation'))
    return withDetail(
      removing
        ? '暂存的权限助手在操作过程中被改动，出于安全考虑已中止。\n请重新打开 WeQ 后再撤销一次。'
        : '暂存的权限助手在安装过程中被改动，出于安全考虑安装已中止。\n请重新打开 WeQ 后点「修复授权」重试。',
    );

  if (detail.includes('invalid install identity or protocol'))
    return withDetail('权限助手与当前 WeQ 版本不匹配，请更新原生组件后再试。');

  if (detail.includes('administrator authorization required'))
    return withDetail('没有拿到管理员权限，安装未进行。请在系统授权窗口里选择允许后再试。');

  if (detail.includes('已取消长期授权操作')) return { message: detail, needsUserAction: false };

  return {
    message: `${removing ? '撤销长期授权' : '启用长期授权'}失败：${detail}`,
    needsUserAction: false,
  };
}
