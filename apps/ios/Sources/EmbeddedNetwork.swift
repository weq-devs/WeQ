import Combine
import Foundation
import TailscaleKit

private struct SilentLogger: LogSink {
    var logFileHandle: Int32? { -1 }
    func log(_ message: String) {}
}

private struct TailnetStatus: Decodable {
    let BackendState: String
    let AuthURL: String?
    let TailscaleIPs: [String]?

    var loginURL: URL? {
        guard let AuthURL, let url = URL(string: AuthURL), url.scheme == "https",
              url.host == "login.tailscale.com", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443 else { return nil }
        return url
    }
}

@MainActor
final class EmbeddedNetwork: ObservableObject {
    @Published private(set) var enabled = false
    @Published private(set) var connected = false
    @Published private(set) var message = "未启动"
    @Published private(set) var loginURL: URL?
    @Published private(set) var address: String?
    private var node: TailscaleNode?
    private var revision = 0
    private var refreshing = false
    private var closing: Task<Void, Never>?
    private let controlURL: String

    init(controlURL: String? = nil) { self.controlURL = controlURL ?? Self.integrationControl ?? kDefaultControlURL }

    static var integrationControl: String? {
        #if DEBUG && targetEnvironment(simulator)
        guard ProcessInfo.processInfo.arguments.contains("--remote-ts-integration-test"),
              let value = ProcessInfo.processInfo.environment["WEQ_REMOTE_TEST_CONTROL"],
              let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1",
              url.port != nil, url.path.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { return nil }
        return value
        #else
        return nil
        #endif
    }

    func start() async {
        guard !enabled else { return }
        enabled = true
        message = "正在连接"
        await refresh()
    }

    func refresh() async {
        guard enabled, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let generation = revision
        do {
            if let closing { await closing.value }
            guard generation == revision, enabled else { return }
            closing = nil
            if node == nil {
                let control = controlURL
                let created = try await Task.detached(priority: .utility) {
                    var directory = try FileManager.default.url(for: .applicationSupportDirectory,
                        in: .userDomainMask, appropriateFor: nil, create: true)
                        .appendingPathComponent(control == kDefaultControlURL ? "WeQRemoteNetwork" : "WeQRemoteNetwork-Integration", isDirectory: true)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                        attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
                    var values = URLResourceValues()
                    values.isExcludedFromBackup = true
                    try directory.setResourceValues(values)
                    return try TailscaleNode(config: Configuration(hostName: "weq-remote-ios", path: directory.path,
                        authKey: nil, controlURL: control, ephemeral: false), logger: SilentLogger())
                }.value
                guard generation == revision, enabled else { try? await created.close(); return }
                node = created
            }
            guard let node else { throw RemoteError.network }
            let raw = try await node.statusJSON()
            guard raw.count < 1_048_576, generation == revision else { return }
            let status = try JSONDecoder().decode(TailnetStatus.self, from: raw)
            connected = status.BackendState == "Running"
            loginURL = status.loginURL
            address = connected ? status.TailscaleIPs?.first : nil
            switch status.BackendState {
            case "Running": message = "已连接"
            case "NeedsLogin": message = "等待网络登录"
            case "NeedsMachineAuth": message = "等待网络管理员批准"
            default: message = "正在连接"
            }
        } catch {
            if generation == revision { connected = false; message = "网络连接失败，请重试" }
        }
    }

    func session() async throws -> URLSession {
        guard connected, let node else { throw RemoteError.network }
        let configuration = Self.configuration()
        let generation = revision
        try await configuration.proxyVia(node)
        guard generation == revision, connected else { throw CancellationError() }
        return URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 15
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return configuration
    }

    func stop(disable: Bool = true) async {
        revision += 1
        if disable { enabled = false }
        connected = false
        loginURL = nil
        address = nil
        message = disable ? "未启动" : "已暂停"
        let previous = node
        node = nil
        if let previous { closing = Task { try? await previous.close() } }
        await closing?.value
    }
}
