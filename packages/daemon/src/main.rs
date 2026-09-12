//! weq-daemon — WeQ 伴生守护进程。
//!
//! 职责被刻意压到最小：
//!   1. 在 `127.0.0.1:<port>` 上提供静态文件服务（docroot 由外部传入），
//!      服务 WeQ 助手推文的封面 / 跳转页；
//!   2. 暴露一条本地控制管道（named pipe / unix socket），WeQ 连上来可以
//!      发命令：开 / 关 HTTP 服务、心跳、探活，以及未来的扩展命令
//!      （例如「监听 GitHub release 更新」之类，都走同一条管道加命令字）。
//!
//! 它【永远不碰 QQ 数据库】，也不读写任何 WeQ 配置 —— 端口与 docroot 都是
//! 外部（WeQ GUI）通过控制命令传入的；进程重启后由外部重新下发。
//!
//! 生命周期由 CLI 参数决定（平台自启动注册的命令行见 `autostart`）：
//!   - `weq-daemon serve`   守护进程模式：起控制管道，等 WeQ 下发命令
//!   - `weq-daemon ping`    一次性探活：向运行中的守护进程发 ping，打印回复
//!   - `weq-daemon http-status` 查询 HTTP 服务状态
//!   - `weq-daemon stop`    一次性停止运行中的守护进程
//!   - `weq-daemon install|uninstall|status [--pipe <name>]` 管理平台自启动
//!
//! `serve` 每次启动都会幂等自注册平台自启（见 `autostart::ensure`）：注册被删了
//! 自动补回、二进制换了路径自动重写。`install` 只是「注册 + 立刻启动」的显式入口。
//!
//! 所有子命令都接受 `--pipe <name>` 覆盖默认管道名，保证同一台机器可以
//! 并存多套（不同管道名 + 不同端口），测试互不干扰。

mod autostart;
mod gui_autostart;
mod httpd;
mod logger;
mod persist;
mod pipe;
mod protocol;
mod release;
mod state;

use std::process::ExitCode;

use crate::protocol::{Request, Response, DEFAULT_PIPE_NAME};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> ExitCode {
    logger::init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            logger::error(&format!("fatal: {err}"));
            eprintln!("weq-daemon: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let (cmd, rest) = match args.split_first() {
        Some(pair) => pair,
        None => return Err(usage()),
    };
    let pipe_name = flag_value(rest, "--pipe").unwrap_or_else(|| DEFAULT_PIPE_NAME.to_string());

    match cmd.as_str() {
        "serve" => serve(&pipe_name),
        "ping" => client_once(&pipe_name, &Request::Ping),
        "http-status" => client_once(&pipe_name, &Request::HttpStatus),
        "stop" => client_once(&pipe_name, &Request::Stop),
        "release-status" => client_once(&pipe_name, &Request::ReleaseWatchStatus),
        "autostart-status" => client_once(&pipe_name, &Request::AutostartStatus),
        "install" => autostart::install(&pipe_name),
        "uninstall" => autostart::uninstall_with(&pipe_name),
        "status" => {
            let installed = autostart::status(&pipe_name)?;
            println!(
                "{}",
                if installed {
                    "installed"
                } else {
                    "not installed"
                }
            );
            Ok(())
        }
        "--version" | "-V" | "version" => {
            println!("weq-daemon {VERSION}");
            Ok(())
        }
        "--help" | "-h" | "help" => {
            println!("{USAGE_TEXT}");
            Ok(())
        }
        other => Err(format!("unknown command `{other}`\n{}", usage())),
    }
}

/// 守护进程模式：自注册平台自启 → 按记忆恢复 HTTP → 起控制管道 → 等命令。
///
/// HTTP 服务若上次开着（状态文件还在），这里就自主恢复 —— 电脑重启后
/// WeQ 不在场也能让卡片 URL 活着。恢复 / 注册失败只记日志，绝不阻塞管道就绪。
fn serve(pipe_name: &str) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;

    runtime.block_on(async move {
        logger::info(&format!("weq-daemon {VERSION} serving; pipe={pipe_name}"));
        pipe::run_control_loop(pipe_name).await
    })
}

/// 一次性客户端：连上控制管道 → 发一个请求 → 打印回复 → 退出。
fn client_once(pipe_name: &str, req: &Request) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;
    runtime.block_on(async move {
        let resp = pipe::call_once(pipe_name, req).await?;
        print_response(&resp);
        Ok(())
    })
}

fn print_response(resp: &Response) {
    match resp {
        Response::Pong {
            version,
            http_running,
        } => {
            println!("pong version={version} http_running={http_running}");
        }
        Response::Started { port } => println!("started port={port}"),
        Response::Stopped => println!("stopped"),
        Response::HttpStatus {
            running,
            port,
            docroot,
        } => match (running, port, docroot) {
            (true, Some(port), Some(docroot)) => {
                println!("running port={port} docroot={docroot}");
            }
            (true, _, _) => println!("running"),
            (false, _, _) => println!("not running"),
        },
        Response::ReleaseWatchStatus(info) => {
            let crate::protocol::ReleaseWatchInfo {
                watching,
                repo,
                interval_secs,
                current_version,
                latest_seen,
                pending,
                last_error,
            } = info;
            let watching = *watching;
            if watching {
                println!(
                    "watching repo={:?} interval={:?} current={:?} latest={:?} pending={:?} error={:?}",
                    repo, interval_secs, current_version, latest_seen, pending, last_error
                );
            } else {
                println!("not watching");
            }
        }
        Response::AutostartApplied { enabled } => {
            println!("autostart enabled={enabled}");
        }
        Response::AutostartStatus {
            enabled,
            registered,
        } => {
            println!("autostart enabled={enabled} registered={registered}");
        }
        Response::Error { message } => println!("error: {message}"),
    }
}

fn usage() -> String {
    USAGE_TEXT.to_string()
}

const USAGE_TEXT: &str = "\
weq-daemon — WeQ 伴生守护进程

USAGE:
  weq-daemon <COMMAND> [--pipe <name>]

COMMANDS:
  serve        守护进程模式（启动时幂等自注册平台自启）
  ping         探活运行中的守护进程
  http-status  查询 HTTP 服务状态（运行中则带端口 / docroot）
  release-status  查询 GitHub release 轮询状态（含未确认的新版本）
  autostart-status  查询自启动状态（WeQ 开机拉起意图 + 守护进程自身注册）
  stop         停止运行中的守护进程
  install      注册平台自启动并立刻启动（schtasks / LaunchAgent / systemd user unit）
  uninstall    移除平台自启动注册
  status       查询自启动注册状态

OPTIONS:
  --pipe <name>  控制管道名（默认 weq-daemon）";

/// 从参数列表里取 `--flag <value>` 的值。
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}
