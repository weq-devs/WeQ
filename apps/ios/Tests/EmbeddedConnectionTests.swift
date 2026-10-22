import XCTest
@testable import WeQRemote

final class EmbeddedConnectionTests: XCTestCase {
    @MainActor
    func testEmbeddedTSConnectionAndRevocation() async throws {
        let fixture = URL(string: "http://127.0.0.1:45198")!
        let configuration: NetworkConfiguration
        do {
            let (data, response) = try await URLSession.shared.data(from: fixture.appendingPathComponent("test/network"))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw RemoteError.network }
            configuration = try JSONDecoder().decode(NetworkConfiguration.self, from: data)
        } catch { throw XCTSkip("未启动本机隔离 TS 测试网络") }
        let network = EmbeddedNetwork(controlURL: configuration.control)
        await network.start()
        do {
            for _ in 0..<40 {
                await network.refresh()
                if network.connected { break }
                try await Task.sleep(for: .milliseconds(500))
            }
            XCTAssertTrue(network.connected)
            let (data, _) = try await URLSession.shared.data(from: fixture.appendingPathComponent("test/invitation"))
            let invitation = try PairingInvitation(JSONDecoder().decode(Invitation.self, from: data).url)
            let session = try await network.session()
            defer { session.invalidateAndCancel() }
            let api = RemoteAPI(endpoint: invitation.endpoint, session: session)
            let token = try DeviceCredential()
            let claim: PairClaim = try await api.request("v1/pair", method: "POST", body: [
                "invitation": invitation.secret, "name": "iOS TS integration", "tokenHash": token.hash,
            ])
            var approved = false
            for _ in 0..<20 {
                let result: PairApproval = try await api.request("v1/pair/\(claim.id.uuidString.lowercased())", token: token.token)
                if result.approved { approved = true; break }
                try await Task.sleep(for: .milliseconds(250))
            }
            XCTAssertTrue(approved)
            let status: ComputerStatus = try await api.request("v1/status", token: token.token)
            try status.validate()
            var revoke = URLRequest(url: fixture.appendingPathComponent("test/revoke"))
            revoke.httpMethod = "POST"
            _ = try await URLSession.shared.data(for: revoke)
            do {
                let _: ComputerStatus = try await api.request("v1/status", token: token.token)
                XCTFail("电脑撤销后仍然接受旧凭据")
            } catch RemoteError.unauthorized { }
            session.invalidateAndCancel()
            await network.stop(disable: false)
            for _ in 0..<40 {
                await network.refresh()
                if network.connected { break }
                try await Task.sleep(for: .milliseconds(500))
            }
            XCTAssertTrue(network.connected, "关闭后的内嵌节点应能重新建立连接")
            await network.stop()
        } catch {
            await network.stop()
            throw error
        }
    }
}

private struct NetworkConfiguration: Decodable { let control: String; let endpoint: String }
private struct Invitation: Decodable { let url: String }
