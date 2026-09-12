//! 平台自启动注册：schtasks（win） / LaunchAgent（macOS） / systemd user unit（linux）。
//!
//! 全部按「登录时启动」注册，命令行固定为：
//!
//!   <exe绝对路径> serve --pipe <pipeName>
//!
//! 端口 / docroot 不写进注册 —— 那些由 WeQ 运行时通过管道下发，注册里只有
//! 二进制位置与管道名。卸载 / 查询都按管道名推导的固定标识操作。
//!
//! **这是全机唯一一份原生自启注册**：WeQ GUI 不走原生自启（它只是一条让守护进程
//! 开机拉起的记忆，见 `gui_autostart.rs`）。`serve` 每次启动都会幂等自注册
//! （[`ensure`]），所以注册被删会自动补回、二进制换路径会自动重写。

use crate::logger;
use crate::protocol::DEFAULT_PIPE_NAME;

/// 设了它就跳过自注册。
///
/// 不参与系统自启的宿主（开发态 `pnpm dev`、浏览器版）拉起守护进程时下发：前者
/// 的二进制是仓库构建产物，后者由部署方用 systemd / 计划任务托管 —— 注册成开机
/// 自启都没有意义（与 GUI 侧 `HostBridge::canAutostart` 同一个取舍）。
pub const NO_AUTOSTART_ENV: &str = "WEQ_DAEMON_NO_AUTOSTART";

/// 自启动注册里用的固定标识（任务名 / label / unit 名）。
pub fn ident(pipe_name: &str) -> String {
    if pipe_name == DEFAULT_PIPE_NAME {
        "weq-daemon".to_string()
    } else {
        format!("weq-daemon-{pipe_name}")
    }
}

/// 当前可执行文件的绝对路径。
fn exe_path() -> Result<std::path::PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("resolve current exe: {e}"))
}

/// 幂等确保「**下次登录**时系统会拉起守护进程」。
///
/// `serve` 每次启动都调用一次，所以：
///   - 注册被用户手动删了 → 自动补回；
///   - 二进制换了路径（升级 / 换了安装位置）→ 注册内容重写指向新路径。
///
/// 与 [`install`] 的区别：这里**不尝试启动当前实例**。调用方就是正在跑的那个
/// 进程，再 `--now` / `bootstrap` 一份只会撞单例后立刻退出（macOS 的
/// `KeepAlive=true` 还会因此变成起-退循环）。
///
/// 注册里必须写**稳定路径**：指向安装包内 / AppImage 挂载点的话下次开机就失效了。
/// GUI 侧负责先把二进制 stage 到数据目录再从这里拉起。
pub fn ensure(pipe_name: &str) -> Result<(), String> {
    if std::env::var_os(NO_AUTOSTART_ENV).is_some() {
        logger::info(&format!(
            "autostart ensure skipped ({NO_AUTOSTART_ENV} is set)"
        ));
        return Ok(());
    }
    ensure_platform(pipe_name)
}

/// 运行外部命令并要求成功，失败时带 stderr。
fn run(cmd: &mut std::process::Command, what: &str) -> Result<(), String> {
    let out = cmd
        .output()
        .map_err(|e| format!("{what}: spawn failed: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{what} failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// 只在内容变化时写文件，返回是否真的写了。
///
/// `serve` 每次启动都会走一遍幂等注册，不能无条件覆写 —— 内容没变就不碰文件，
/// 也就省掉一次 `daemon-reload` / 重新注册。
#[cfg(unix)]
fn write_if_changed(path: &std::path::Path, content: &str) -> Result<bool, String> {
    match std::fs::read_to_string(path) {
        Ok(existing) if existing == content => Ok(false),
        _ => {
            std::fs::write(path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
            Ok(true)
        }
    }
}

/// XML 文本转义（`&` `<` `>` `"` `'`）。
#[cfg_attr(not(windows), allow(dead_code))]
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// `schtasks /Create /TN <name> /XML <file>` 用的任务 XML：当前用户登录时启动。
///
/// 为什么要走 /XML 而不是 `/SC ONLOGON`：后者生成的 `<LogonTrigger>` 不带
/// `<UserId>`，语义是「任意用户登录」，注册它需要管理员权限 —— 普通账户（哪怕在
/// Administrators 组里、但被 UAC 过滤成 deny-only）只会拿到「错误: 拒绝访问。」。
/// 把触发器限定到当前用户才免提权，效果等价：仅在该用户登录时、以他的身份启动。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn task_xml(command: &str, arguments: Option<&str>, user: &str) -> String {
    let exec = match arguments {
        Some(a) if !a.is_empty() => format!(
            "<Command>{}</Command><Arguments>{}</Arguments>",
            xml_escape(command),
            xml_escape(a)
        ),
        _ => format!("<Command>{}</Command>", xml_escape(command)),
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>WeQ autostart (managed by weq-daemon)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <UserId>{user}</UserId>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <AllowHardTerminate>false</AllowHardTerminate>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>{exec}</Exec>
  </Actions>
</Task>
"#,
        user = xml_escape(user),
        exec = exec,
    )
}

/// 当前用户在 Task Scheduler 里的主体名（`DOMAIN\User`；取不到域时退化成 `User`）。
#[cfg(windows)]
fn current_user() -> Result<String, String> {
    let user = std::env::var("USERNAME").map_err(|_| "USERNAME not set".to_string())?;
    if user.is_empty() {
        return Err("USERNAME is empty".to_string());
    }
    Ok(match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() => format!("{domain}\\{user}"),
        _ => user,
    })
}

/// 以 UTF-16LE + BOM 写文件：`schtasks /XML` 只接受 Unicode 编码的 XML。
#[cfg(windows)]
fn write_utf16le(path: &std::path::Path, text: &str) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(text.len() * 2 + 2);
    bytes.extend_from_slice(&[0xFF, 0xFE]);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

/// 注册「当前用户登录时启动」的计划任务（`/Create /F /TN <name> /XML <file>`）。
#[cfg(windows)]
pub(crate) fn create_task(
    name: &str,
    command: &str,
    arguments: Option<&str>,
    what: &str,
) -> Result<(), String> {
    let xml = task_xml(command, arguments, &current_user()?);
    let path = std::env::temp_dir().join(format!("{name}.task.xml"));
    write_utf16le(&path, &xml)?;
    let result = run(
        no_window(&mut std::process::Command::new("schtasks"))
            .args(["/Create", "/F", "/TN", name, "/XML"])
            .arg(&path),
        what,
    );
    let _ = std::fs::remove_file(&path);
    result
}

/// Windows 的 schtasks / powershell 都是控制台程序；守护进程由 GUI 以 detached
/// 方式拉起、本身没有控制台，直接 spawn 会每次弹一个一闪而过的黑窗口（例如
/// 设置页每 10s 的健康轮询查一次 autostart 注册状态就闪一次）。统一加
/// CREATE_NO_WINDOW（0x08000000）隐藏控制台。
#[cfg(windows)]
pub(crate) fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

fn home_dir() -> Result<std::path::PathBuf, String> {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "HOME not set".to_string())
}

/// `serve` 启动时的幂等自注册（见 [`ensure`]）。
///
/// Windows 的 `schtasks /Create /F` 本身就是覆盖语义，所以每次 `serve` 都按当前
/// exe 路径重写一遍就是幂等的 —— 注册指向的路径变了（升级 / 换安装位置）自然自愈。
#[cfg(windows)]
fn ensure_platform(pipe_name: &str) -> Result<(), String> {
    let exe = exe_path()?;
    let name = ident(pipe_name);
    create_task(
        &name,
        &exe.display().to_string(),
        Some(&format!("serve --pipe {pipe_name}")),
        "schtasks register",
    )
}

// ---------- Windows: schtasks ONLOGON ----------

#[cfg(windows)]
pub fn install(pipe_name: &str) -> Result<(), String> {
    let name = ident(pipe_name);
    ensure_platform(pipe_name)?;
    logger::info(&format!("autostart installed: task {name}"));
    Ok(())
}

#[cfg(windows)]
pub fn uninstall_with(pipe_name: &str) -> Result<(), String> {
    let name = ident(pipe_name);
    // 查到存在才删，避免把「没装过」当失败。
    match no_window(&mut std::process::Command::new("schtasks"))
        .args(["/Query", "/TN", &name])
        .output()
    {
        Ok(out) if out.status.success() => {}
        _ => return Ok(()),
    }
    run(
        no_window(&mut std::process::Command::new("schtasks"))
            .args(["/Delete", "/F", "/TN", &name]),
        "schtasks delete",
    )?;
    logger::info(&format!("autostart removed: task {name}"));
    Ok(())
}

#[cfg(windows)]
pub fn status(pipe_name: &str) -> Result<bool, String> {
    let name = ident(pipe_name);
    let out = no_window(&mut std::process::Command::new("schtasks"))
        .args(["/Query", "/TN", &name])
        .output()
        .map_err(|e| format!("schtasks query: {e}"))?;
    Ok(out.status.success())
}

// ---------- macOS: LaunchAgent plist ----------

#[cfg(target_os = "macos")]
fn plist_content(exe: &std::path::Path, pipe_name: &str) -> String {
    let label = ident(pipe_name);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>serve</string>
    <string>--pipe</string>
    <string>{pipe_name}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
"#,
        exe.display()
    )
}

/// 只写 plist（内容变了才写），**不 bootstrap**。
///
/// `~/Library/LaunchAgents/` 下的 plist 在下次登录时由 launchd 自动加载，
/// 所以「只写不加载」已经满足「下次开机自启」。绝不能在这里 bootstrap：调用方
/// 就是正在跑的实例，launchd 再起一份会撞单例退出 —— plist 是 `KeepAlive=true`，
/// 那就变成「起了就退、退了又起」的循环。
#[cfg(target_os = "macos")]
fn ensure_platform(pipe_name: &str) -> Result<(), String> {
    let exe = exe_path()?;
    let label = ident(pipe_name);
    let agents_dir = home_dir()?.join("Library/LaunchAgents");
    std::fs::create_dir_all(&agents_dir).map_err(|e| format!("create LaunchAgents dir: {e}"))?;
    let plist_path = agents_dir.join(format!("{label}.plist"));
    write_if_changed(&plist_path, &plist_content(&exe, pipe_name))?;
    Ok(())
}

/// 显式安装（`weq-daemon install`）：注册 + 立刻加载。
#[cfg(target_os = "macos")]
pub fn install(pipe_name: &str) -> Result<(), String> {
    ensure_platform(pipe_name)?;
    let label = ident(pipe_name);
    let plist_path = home_dir()?.join(format!("Library/LaunchAgents/{label}.plist"));
    // 已加载同名 label 就先 bootout（失败忽略 —— 多半是本来没加载）。
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", "gui/$UID", label.as_str()])
        .output();
    run(
        std::process::Command::new("launchctl")
            .args(["bootstrap", "gui/$UID"])
            .arg(&plist_path),
        "launchctl bootstrap",
    )?;
    logger::info(&format!("autostart installed: {label}"));
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn uninstall_with(pipe_name: &str) -> Result<(), String> {
    let label = ident(pipe_name);
    let plist_path = home_dir()?.join(format!("Library/LaunchAgents/{label}.plist"));
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", "gui/$UID", label.as_str()])
        .output();
    match std::fs::remove_file(&plist_path) {
        Ok(()) => Ok(()),
        Err(_) if !plist_path.exists() => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", plist_path.display())),
    }
}

#[cfg(target_os = "macos")]
pub fn status(pipe_name: &str) -> Result<bool, String> {
    let label = ident(pipe_name);
    let plist = home_dir()?.join(format!("Library/LaunchAgents/{label}.plist"));
    Ok(plist.exists())
}

// ---------- Linux: systemd user unit ----------

#[cfg(all(unix, not(target_os = "macos")))]
fn unit_dir() -> Result<std::path::PathBuf, String> {
    Ok(home_dir()?.join(".config/systemd/user"))
}

/// unit 内容。`ExecStart` 必须指向**稳定路径** —— 指向安装包内 / AppImage 挂载点
/// 的话下次开机就失效了（GUI 侧会先把二进制 stage 到数据目录，再从这里拉起）。
/// 路径加引号：systemd 按空白分词，HOME 里带空格时不加引号会解析错。
#[cfg(all(unix, not(target_os = "macos")))]
fn unit_content(exe: &std::path::Path, pipe_name: &str) -> String {
    format!(
        "[Unit]\n\
         Description=WeQ companion daemon\n\
         After=graphical-session.target\n\n\
         [Service]\n\
         ExecStart=\"{}\" serve --pipe {pipe_name}\n\
         Restart=on-failure\n\
         RestartSec=3\n\n\
         [Install]\n\
         WantedBy=default.target\n",
        exe.display()
    )
}

/// 幂等注册（**不启动**本实例）。
///
/// `enable` 的产物就是 `default.target.wants/<unit>` 软链，直接看文件比再 spawn
/// 一次 `systemctl is-enabled` 便宜。
#[cfg(all(unix, not(target_os = "macos")))]
fn ensure_platform(pipe_name: &str) -> Result<(), String> {
    let exe = exe_path()?;
    let unit = ident(pipe_name);
    let dir = unit_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create systemd user dir: {e}"))?;
    let unit_path = dir.join(format!("{unit}.service"));
    if write_if_changed(&unit_path, &unit_content(&exe, pipe_name))? {
        run(
            std::process::Command::new("systemctl").args(["--user", "daemon-reload"]),
            "systemctl daemon-reload",
        )?;
    }
    let wants = dir
        .join("default.target.wants")
        .join(format!("{unit}.service"));
    if !wants.exists() {
        run(
            std::process::Command::new("systemctl").args([
                "--user",
                "enable",
                &format!("{unit}.service"),
            ]),
            "systemctl enable",
        )?;
    }
    enable_linger();
    Ok(())
}

/// linger：未登录桌面时 user manager 也在跑，守护进程才能真「开机自启」。
/// 部分环境（容器 / 无 loginctl）会失败 —— 只警告，不阻塞。
#[cfg(all(unix, not(target_os = "macos")))]
fn enable_linger() {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_default();
    if user.is_empty() {
        return;
    }
    if let Err(err) = run(
        std::process::Command::new("loginctl").args(["enable-linger", &user]),
        "loginctl enable-linger",
    ) {
        logger::warn(&format!(
            "enable-linger failed (autostart still works after login): {err}"
        ));
    }
}

/// 显式安装（`weq-daemon install`）：注册 + 立刻 `enable --now` 拉起来。
#[cfg(all(unix, not(target_os = "macos")))]
pub fn install(pipe_name: &str) -> Result<(), String> {
    ensure_platform(pipe_name)?;
    let unit = ident(pipe_name);
    run(
        std::process::Command::new("systemctl").args([
            "--user",
            "enable",
            "--now",
            &format!("{unit}.service"),
        ]),
        "systemctl enable",
    )?;
    logger::info(&format!("autostart installed: {unit}.service"));
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn uninstall_with(pipe_name: &str) -> Result<(), String> {
    let unit = ident(pipe_name);
    let unit_path = home_dir()?.join(format!(".config/systemd/user/{unit}.service"));
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "disable", "--now", &format!("{unit}.service")])
        .output();
    match std::fs::remove_file(&unit_path) {
        Ok(()) => {
            let _ = std::process::Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .output();
            Ok(())
        }
        Err(_) if !unit_path.exists() => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", unit_path.display())),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn status(pipe_name: &str) -> Result<bool, String> {
    let unit = ident(pipe_name);
    let unit_path = home_dir()?.join(format!(".config/systemd/user/{unit}.service"));
    Ok(unit_path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ident_uses_default_without_suffix() {
        assert_eq!(ident("weq-daemon"), "weq-daemon");
        assert_eq!(ident("weq-daemon-test"), "weq-daemon-weq-daemon-test");
    }

    #[test]
    fn task_xml_is_user_scoped_logon_trigger() {
        let xml = task_xml(
            r"C:\Program Files\WeQ&Co\weQ.exe",
            Some("serve --pipe weq-daemon"),
            r"H3COF6\x 17078",
        );
        // 触发器必须带 <UserId>：不带的话就是「任意用户登录」，会被拒绝访问。
        let trigger = xml
            .split("<LogonTrigger>")
            .nth(1)
            .and_then(|s| s.split("</LogonTrigger>").next())
            .expect("LogonTrigger present");
        assert!(trigger.contains("<UserId>H3COF6\\x 17078</UserId>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<Command>C:\\Program Files\\WeQ&amp;Co\\weQ.exe</Command>"));
        assert!(xml.contains("<Arguments>serve --pipe weq-daemon</Arguments>"));

        // 无参数任务不应留下空的 <Arguments>。
        let bare = task_xml(r"C:\x.exe", None, "u");
        assert!(!bare.contains("<Arguments>"));
    }
}
