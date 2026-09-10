//! 平台自启动注册：schtasks（win） / LaunchAgent（macOS） / systemd user unit（linux）。
//!
//! 全部按「登录时启动」注册，命令行固定为：
//!
//!   <exe绝对路径> serve --pipe <pipeName>
//!
//! 端口 / docroot 不写进注册 —— 那些由 WeQ 运行时通过管道下发，注册里只有
//! 二进制位置与管道名。卸载 / 查询都按管道名推导的固定标识操作。

use crate::logger;
use crate::protocol::DEFAULT_PIPE_NAME;

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

// ---------- Windows: schtasks ONLOGON ----------

#[cfg(windows)]
pub fn install(pipe_name: &str) -> Result<(), String> {
    let exe = exe_path()?;
    let name = ident(pipe_name);
    // /F = 覆盖已存在任务；/SC ONLOGON = 该用户每次登录时启动；/RL LIMITED。
    // schtasks 的 /TR 含嵌套引号很挑，用 PowerShell -EncodedCommand 传。
    let ps = format!(
        "schtasks /Create /F /SC ONLOGON /RL LIMITED /TN '{name}' /TR \"'{}' serve --pipe {pipe_name}\"",
        exe.display()
    );
    let mut encoded = String::new();
    for unit in ps.encode_utf16() {
        encoded.push_str(&format!("{unit:04X}"));
    }
    run(
        no_window(&mut std::process::Command::new("powershell")).args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded,
        ]),
        "schtasks register",
    )?;
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
        no_window(&mut std::process::Command::new("schtasks")).args(["/Delete", "/F", "/TN", &name]),
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
pub fn install(pipe_name: &str) -> Result<(), String> {
    let exe = exe_path()?;
    let label = ident(pipe_name);
    let agents_dir = home_dir()?.join("Library/LaunchAgents");
    std::fs::create_dir_all(&agents_dir).map_err(|e| format!("create LaunchAgents dir: {e}"))?;
    let plist_path = agents_dir.join(format!("{label}.plist"));
    let plist = format!(
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
    );
    std::fs::write(&plist_path, plist)
        .map_err(|e| format!("write {}: {e}", plist_path.display()))?;
    // 已加载同名 label 就先 bootout（失败忽略 —— 多半是本来没加载）。
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", "gui/$UID", &format!("{label}")])
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
        .args(["bootout", "gui/$UID", &format!("{label}")])
        .output();
    match std::fs::remove_file(&plist_path) {
        Ok(()) | Err(_) if !plist_path.exists() => Ok(()),
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
pub fn install(pipe_name: &str) -> Result<(), String> {
    let exe = exe_path()?;
    let unit = ident(pipe_name);
    let unit_dir = home_dir()?.join(".config/systemd/user");
    std::fs::create_dir_all(&unit_dir).map_err(|e| format!("create systemd user dir: {e}"))?;
    let unit_path = unit_dir.join(format!("{unit}.service"));
    let content = format!(
        "[Unit]\n\
         Description=WeQ companion daemon\n\
         After=graphical-session.target\n\n\
         [Service]\n\
         ExecStart={} serve --pipe {pipe_name}\n\
         Restart=on-failure\n\
         RestartSec=3\n\n\
         [Install]\n\
         WantedBy=default.target\n",
        exe.display()
    );
    std::fs::write(&unit_path, content)
        .map_err(|e| format!("write {}: {e}", unit_path.display()))?;
    run(
        std::process::Command::new("systemctl").args(["--user", "daemon-reload"]),
        "systemctl daemon-reload",
    )?;
    run(
        std::process::Command::new("systemctl").args([
            "--user",
            "enable",
            "--now",
            &format!("{unit}.service"),
        ]),
        "systemctl enable",
    )?;
    // linger：未登录桌面时 user manager 也在跑，守护进程才能真「开机自启」。
    // 部分环境（容器 / 无 loginctl）会失败 —— 只警告，不阻塞安装。
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_default();
    if !user.is_empty() {
        if let Err(err) = run(
            std::process::Command::new("loginctl").args(["enable-linger", &user]),
            "loginctl enable-linger",
        ) {
            logger::warn(&format!(
                "enable-linger failed (autostart still works after login): {err}"
            ));
        }
    }
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
}
