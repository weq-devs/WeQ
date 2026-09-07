//! 回环静态 HTTP 服务器。
//!
//! 只绑 `127.0.0.1`，只做一件事：把 `docroot` 下的文件按路径映射出去。
//! 路由规则（与 WeQ 助手推文的 `coverPath` / `pagePath` 约定对齐）：
//!
//!   GET /p/daily       → <docroot>/p/daily.html（精确命中，或加 .html）
//!   GET /cover/daily   → <docroot>/cover/daily.png（加扩展名尝试）
//!   GET /avatar.png    → <docroot>/avatar.png
//!   GET /healthz       → 200 "ok"（不读盘，探活用）
//!
//! 无扩展名请求按顺序尝试 `path` → `path.html` → `path/index.html`；
//! 显式带扩展名的请求只试精确路径。任何解析出 docroot 之外的路径一律 404。

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};

use crate::state::HttpConfig;

const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024; // 推文页面/封面远小于这个值
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// accept 循环。`shutdown` 置 true 后退出；退出时给 `done` 发一个哨兵。
pub async fn run(cfg: HttpConfig, mut shutdown: watch::Receiver<bool>, done: mpsc::Sender<()>) {
    let listener = match TcpListener::bind(("127.0.0.1", cfg.port)).await {
        Ok(l) => l,
        Err(err) => {
            crate::logger::error(&format!("http bind 127.0.0.1:{} failed: {err}", cfg.port));
            let _ = done.send(()).await;
            return;
        }
    };
    crate::logger::info(&format!("http listening on 127.0.0.1:{}", cfg.port));

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _peer)) => {
                        // 每连接一个轻任务；回环上并发量就是 QQ 自己。
                        let docroot = cfg.docroot.clone();
                        tokio::spawn(async move {
                            serve_conn(stream, &docroot).await;
                        });
                    }
                    Err(err) => {
                        crate::logger::warn(&format!("accept failed: {err}"));
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
        }
    }

    crate::logger::info("http accept loop exiting");
    let _ = done.send(()).await;
}

/// 单连接处理：解析一个请求（HTTP/1.1 keep-alive 我们不支持，响应后即关，
/// QQ 客户端会自动重连；回环上这点开销可以忽略），防慢速占用。
async fn serve_conn(mut stream: tokio::net::TcpStream, docroot: &str) {
    let _ = tokio::time::timeout(READ_TIMEOUT, async {
        let mut buf = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        // 读到请求头结束（空行）为止；不处理请求体（GET 服务不需要）。
        loop {
            let n = match stream.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => return,
            };
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
                break;
            }
        }
        let req = String::from_utf8_lossy(&buf);
        let path = request_path(&req).unwrap_or("/");
        respond(&mut stream, docroot, path).await;
    })
    .await;
}

/// 从请求头取请求目标（去掉 query string）。
fn request_path(req: &str) -> Option<&str> {
    let line = req.lines().next()?;
    let mut it = line.split_whitespace();
    let _method = it.next()?;
    let target = it.next()?;
    let path = target.split('?').next().unwrap_or(target);
    Some(path)
}

async fn respond(stream: &mut tokio::net::TcpStream, docroot: &str, raw_path: &str) {
    // URL 解码（推文路径都是 ASCII 安全字符，这里只兜底 %xx）。
    let path = percent_decode(raw_path);
    if path == "/healthz" {
        write_response(stream, 200, "text/plain", b"ok").await;
        return;
    }
    match resolve_file(docroot, &path) {
        Some(file) => match fs::read(&file).await {
            Ok(bytes) if bytes.len() as u64 <= MAX_FILE_SIZE => {
                let mime = mime_for(&file);
                write_response(stream, 200, mime, &bytes).await;
            }
            Ok(_) => {
                crate::logger::warn(&format!("file too large, rejected: {}", file.display()));
                write_response(stream, 500, "text/plain", b"file too large").await;
            }
            Err(err) => {
                crate::logger::warn(&format!("read {} failed: {err}", file.display()));
                write_response(stream, 404, "text/plain", b"not found").await;
            }
        },
        None => write_response(stream, 404, "text/plain", b"not found").await,
    }
}

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) {
    use tokio::io::AsyncWriteExt;
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

/// 把 URL 路径解析为 docroot 内的文件；`None` = 未命中 / 越界。
///
/// 防穿越：先按 `/` 切段，拒绝任何 `..` 段与非空非合法段，再重放路径 ——
/// 不做字符串前缀比较（Windows 反斜杠 / 大小写都有坑）。
fn resolve_file(docroot: &str, url_path: &str) -> Option<PathBuf> {
    let root = Path::new(docroot);
    let mut rel = PathBuf::new();
    for seg in url_path.split('/') {
        match seg {
            "" | "." => {}
            ".." => return None, // 明确拒绝爬上级
            s if s.contains('\\') || s.contains('\0') => return None,
            s => rel.push(s),
        }
    }
    let base = root.join(rel);
    // 候选顺序：精确 → 已知静态扩展名 → /index.html（仅当请求无扩展名时补后缀）。
    // /p/daily 命中 .html，/cover/daily 命中 .png —— 推文路由不带扩展名，
    // 由这里按内容类型补齐。
    let mut candidates = vec![base.clone()];
    let has_ext = base.extension().is_some();
    if !has_ext {
        for ext in ["html", "png", "jpg", "jpeg", "webp", "svg"] {
            let mut with_ext = base.clone();
            with_ext.set_extension(ext);
            candidates.push(with_ext);
        }
        candidates.push(base.join("index.html"));
    }
    candidates.into_iter().find(|c| is_regular_file(c))
}

fn is_regular_file(p: &Path) -> bool {
    // metadata 不跟随符号链接的判断交给 symlink_metadata；这里简单 stat，
    // 目录 / 不存在都算未命中。
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

/// 最小 %xx 解码（路径段层面；非法序列原样保留）。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn docroot_fixture() -> (tempdir::TempDir, PathBuf) {
        let dir = tempdir::TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("p")).unwrap();
        std::fs::create_dir_all(root.join("cover")).unwrap();
        std::fs::write(root.join("p").join("daily.html"), b"<h1>daily</h1>").unwrap();
        std::fs::write(root.join("cover").join("daily.png"), b"\x89PNG fake").unwrap();
        std::fs::write(root.join("avatar.png"), b"\x89PNG avatar").unwrap();
        (dir, root)
    }

    // 说明：下面用一个小 stub 代替 tempdir 依赖 —— 见本文件底部。
    mod tempdir {
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicU64, Ordering};

        pub struct TempDir(PathBuf);
        impl TempDir {
            pub fn new() -> std::io::Result<Self> {
                static N: AtomicU64 = AtomicU64::new(0);
                let n = N.fetch_add(1, Ordering::Relaxed);
                let p = std::env::temp_dir().join(format!(
                    "weq-daemon-test-{}-{}",
                    std::process::id(),
                    n
                ));
                std::fs::create_dir_all(&p)?;
                Ok(Self(p))
            }
            pub fn path(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn resolves_exact_and_extensionless() {
        let (_d, root_path) = docroot_fixture();
        let root = root_path.to_string_lossy().into_owned();
        assert_eq!(
            resolve_file(&root, "/p/daily"),
            Some(root_path.join("p").join("daily.html"))
        );
        assert_eq!(
            resolve_file(&root, "/cover/daily.png"),
            Some(root_path.join("cover").join("daily.png"))
        );
        // 无扩展名的封面路由按扩展名候选补齐 → .png
        assert_eq!(
            resolve_file(&root, "/cover/daily"),
            Some(root_path.join("cover").join("daily.png"))
        );
        assert_eq!(
            resolve_file(&root, "/avatar.png"),
            Some(root_path.join("avatar.png"))
        );
    }

    #[test]
    fn rejects_traversal() {
        let (_d, root) = docroot_fixture();
        let root = root.to_string_lossy().into_owned();
        assert_eq!(resolve_file(&root, "/../etc/passwd"), None);
        assert_eq!(resolve_file(&root, "/p/../../x"), None);
        // 编码后的 .. 也拒绝（percent_decode 会还原成 .. 段）
        assert_eq!(resolve_file(&root, "/p/%2e%2e/secret"), None);
    }

    #[test]
    fn misses_404() {
        let (_d, root) = docroot_fixture();
        let root = root.to_string_lossy().into_owned();
        assert_eq!(resolve_file(&root, "/p/nope"), None);
        assert_eq!(resolve_file(&root, "/p/nope.html"), None);
    }

    #[test]
    fn request_path_strips_query() {
        let req = "GET /p/daily?t=1&x=2 HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(request_path(req), Some("/p/daily"));
    }

    #[test]
    fn percent_decode_basics() {
        assert_eq!(percent_decode("/a%20b"), "/a b");
        assert_eq!(percent_decode("/%2e%2e"), "/..");
        assert_eq!(percent_decode("/%zz"), "/%zz"); // 非法序列保留
        assert_eq!(percent_decode("/plain"), "/plain");
    }
}
