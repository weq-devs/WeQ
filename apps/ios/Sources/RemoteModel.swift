import Combine
import Foundation

@MainActor
final class RemoteModel: ObservableObject {
    @Published var invitationText = ""
    @Published private(set) var busy = false
    @Published private(set) var code: String?
    @Published private(set) var computerAddress: String?
    @Published private(set) var connected = false
    @Published private(set) var paired = false
    @Published private(set) var message = "未配对"
    @Published private(set) var latency: Int?
    @Published private(set) var checkedAt: Date?
    @Published private(set) var error: String?
    let network: EmbeddedNetwork
    private var api: RemoteAPI?
    private var credential: DeviceCredential?
    private var polling: Task<Void, Never>?
    private var revision = 0

    init(network: EmbeddedNetwork) { self.network = network }

    // 仅模拟器 Debug 构建接受回环测试配置；真机/Release 无系统网络绕行入口。
    private var testEndpoint: URL? {
        #if DEBUG && targetEnvironment(simulator)
        guard ProcessInfo.processInfo.arguments.contains("--remote-integration-test"),
              let value = ProcessInfo.processInfo.environment["WEQ_REMOTE_TEST_ENDPOINT"],
              let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1",
              url.port != nil, url.path.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { return nil }
        return url
        #else
        return nil
        #endif
    }

    var testMode: Bool { testEndpoint != nil }

    func pair() async {
        guard !busy, polling == nil else { return }
        error = nil
        busy = true
        let generation = revision
        defer { if generation == revision { busy = false } }
        do {
            let invitation = try PairingInvitation(invitationText)
            let endpoint = testEndpoint ?? invitation.endpoint
            let session: URLSession
            if testMode { session = URLSession(configuration: EmbeddedNetwork.configuration(), delegate: NoRedirectDelegate(), delegateQueue: nil) }
            else { session = try await network.session() }
            let newAPI = RemoteAPI(endpoint: endpoint, session: session)
            let token = try DeviceCredential()
            let claim: PairClaim
            do {
                claim = try await newAPI.request("v1/pair", method: "POST", body: [
                    "invitation": invitation.secret, "name": "WeQ Remote iOS", "tokenHash": token.hash,
                ])
            } catch { session.invalidateAndCancel(); throw error }
            guard generation == revision else { session.invalidateAndCancel(); return }
            guard claim.code.count == 6, claim.code.allSatisfy(\.isNumber),
                  claim.expiresAt > Date().timeIntervalSince1970 * 1000,
                  claim.expiresAt <= (Date().timeIntervalSince1970 + 180) * 1000 else {
                session.invalidateAndCancel()
                throw RemoteError.response
            }
            api?.session.invalidateAndCancel()
            api = newAPI
            credential = token
            computerAddress = invitation.endpoint.host
            invitationText = ""
            code = claim.code
            connected = false
            latency = nil
            checkedAt = nil
            message = "等待电脑确认"
            polling = Task { [weak self] in await self?.waitForApproval(claim, generation: generation) }
        } catch is CancellationError {} catch {
            if generation == revision { self.error = error.localizedDescription }
        }
    }

    private func waitForApproval(_ claim: PairClaim, generation: Int) async {
        defer { if generation == revision { polling = nil } }
        do {
            while Date().timeIntervalSince1970 * 1000 < claim.expiresAt {
                try Task.checkCancellation()
                guard generation == revision, let api, let credential else { return }
                let approval: PairApproval = try await api.request("v1/pair/\(claim.id.uuidString.lowercased())", token: credential.token)
                guard generation == revision else { return }
                guard approval.id == claim.id, approval.scope == "status:read" else { throw RemoteError.response }
                if approval.approved {
                    paired = true
                    code = nil
                    await refresh()
                    return
                }
                try await Task.sleep(for: .seconds(2))
            }
            throw RemoteError.expired
        } catch is CancellationError {} catch {
            if generation == revision {
                disconnect()
                self.error = error.localizedDescription
            }
        }
    }

    func refresh() async {
        guard let api, let credential else { return }
        let generation = revision
        busy = true
        defer { if generation == revision { busy = false } }
        do {
            let start = ContinuousClock.now
            let status: ComputerStatus = try await api.request("v1/status", token: credential.token)
            try status.validate()
            guard generation == revision else { return }
            let duration = (ContinuousClock.now - start).components
            latency = Int(duration.seconds) * 1000 + Int(duration.attoseconds / 1_000_000_000_000_000)
            checkedAt = Date()
            connected = true
            code = nil
            message = "电脑在线"
            error = nil
        } catch is CancellationError {} catch {
            if generation == revision { fail(error) }
        }
    }

    private func fail(_ failure: Error) {
        connected = false
        message = "连接未通过"
        error = failure.localizedDescription
        if case RemoteError.unauthorized = failure { disconnect(); error = failure.localizedDescription }
    }

    func disconnect() {
        revision += 1
        polling?.cancel()
        polling = nil
        api?.session.invalidateAndCancel()
        api = nil
        credential = nil
        connected = false
        paired = false
        busy = false
        code = nil
        latency = nil
        checkedAt = nil
        computerAddress = nil
        message = "未配对"
        error = nil
    }
}
