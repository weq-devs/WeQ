import CryptoKit
import Foundation
import Security

enum RemoteError: LocalizedError {
    case invitation, network, credential, expired, unauthorized, response, http(Int)

    var errorDescription: String? {
        switch self {
        case .invitation: return "配对链接无效，请重新扫描电脑上的二维码。"
        case .network: return "请先连接 App 内网络，并与电脑登录同一个 Tailscale 网络。"
        case .credential: return "无法生成安全的设备凭据。"
        case .expired: return "电脑确认已超时，请重新生成配对码。"
        case .unauthorized: return "设备未授权或授权已被撤销，请重新配对。"
        case .response: return "电脑返回了不兼容的数据。"
        case .http(let code): return "电脑返回 HTTP \(code)，请检查邀请是否有效。"
        }
    }
}

struct PairingInvitation: Equatable {
    let endpoint: URL
    let secret: String

    init(_ text: String) throws {
        guard text.utf8.count <= 2048,
              let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme == "weq-remote", components.host == "pair",
              components.user == nil, components.password == nil, components.port == nil,
              components.path.isEmpty, components.fragment == nil,
              let items = components.queryItems, items.count == 3,
              Set(items.map(\.name)) == Set(["v", "endpoint", "invitation"]),
              items.first(where: { $0.name == "v" })?.value == "1",
              let rawEndpoint = items.first(where: { $0.name == "endpoint" })?.value,
              let endpoint = URL(string: rawEndpoint), Self.isTailnetEndpoint(endpoint),
              let secret = items.first(where: { $0.name == "invitation" })?.value,
              secret.count == 64, secret.allSatisfy({ "0123456789abcdef".contains($0) })
        else { throw RemoteError.invitation }
        self.endpoint = endpoint
        self.secret = secret
    }

    static func isTailnetEndpoint(_ url: URL) -> Bool {
        guard url.scheme == "http", url.user == nil, url.password == nil,
              url.path.isEmpty, url.query == nil, url.fragment == nil,
              let port = url.port, (1...65535).contains(port), let host = url.host else { return false }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ part in
            guard let number = Int(part) else { return false }
            return String(number) == part
        }),
              let a = Int(parts[0]), let b = Int(parts[1]), let c = Int(parts[2]), let d = Int(parts[3]) else { return false }
        return a == 100 && (64...127).contains(b) && (0...255).contains(c) && (0...255).contains(d)
    }
}

struct DeviceCredential {
    let token: String
    var hash: String { SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined() }

    init() throws {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw RemoteError.credential }
        token = bytes.map { String(format: "%02x", $0) }.joined()
    }
}

struct PairClaim: Decodable {
    let id: UUID
    let code: String
    let expiresAt: Double
}

struct PairApproval: Decodable {
    let id: UUID
    let approved: Bool
    let scope: String
}

struct ComputerStatus: Decodable {
    let product: String
    let `protocol`: Int
    let scope: String
    let online: Bool

    func validate() throws {
        guard product == "WeQ Remote", self.protocol == 1, scope == "status:read", online else { throw RemoteError.response }
    }
}

final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

struct RemoteAPI {
    let endpoint: URL
    let session: URLSession

    func request<T: Decodable>(_ path: String, method: String = "GET", token: String? = nil,
                               body: [String: String]? = nil) async throws -> T {
        var request = URLRequest(url: endpoint.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse else { throw RemoteError.response }
        if response.statusCode == 401 { throw RemoteError.unauthorized }
        guard (200..<300).contains(response.statusCode) else { throw RemoteError.http(response.statusCode) }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 65536 else { throw RemoteError.response }
            data.append(byte)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
