import XCTest
@testable import WeQRemote

final class RemoteProtocolTests: XCTestCase {
    private func link(endpoint: String = "http://100.64.0.10:7691", extra: String = "") -> String {
        "weq-remote://pair?v=1&endpoint=\(endpoint.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!)&invitation=\(String(repeating: "a", count: 64))\(extra)"
    }

    func testAcceptsDesktopInvitation() throws {
        let invitation = try PairingInvitation(link())
        XCTAssertEqual(invitation.endpoint.host, "100.64.0.10")
        XCTAssertEqual(invitation.secret.count, 64)
    }

    func testRejectsNonTailnetDestinations() {
        for endpoint in ["http://127.0.0.1:7691", "http://192.168.1.1:80", "http://100.128.0.1:7691",
                         "http://100.63.0.1:7691", "http://example.com:80", "http://100.64.0.1:7691/path",
                         "http://user@100.64.0.1:7691", "http://100.64.0.1:0", "http://100.64.999.1:7691"] {
            XCTAssertThrowsError(try PairingInvitation(link(endpoint: endpoint)), endpoint)
        }
    }

    func testRejectsDuplicateAndUnknownFields() {
        XCTAssertThrowsError(try PairingInvitation(link(extra: "&v=1")))
        XCTAssertThrowsError(try PairingInvitation(link(extra: "&unknown=1")))
        XCTAssertThrowsError(try PairingInvitation(link().replacingOccurrences(of: "v=1", with: "v=2")))
        XCTAssertThrowsError(try PairingInvitation("https://example.com"))
    }

    func testSecureCredentialMatchesDesktopHashConvention() throws {
        let a = try DeviceCredential(), b = try DeviceCredential()
        XCTAssertEqual(a.token.count, 64)
        XCTAssertEqual(a.hash.count, 64)
        XCTAssertNotEqual(a.token, b.token)
        XCTAssertNotEqual(a.hash, b.hash)
        XCTAssertTrue(a.token.allSatisfy { "0123456789abcdef".contains($0) })
    }

    func testRequiresCompatibleComputerStatus() throws {
        let valid = Data(#"{"product":"WeQ Remote","protocol":1,"scope":"status:read","online":true}"#.utf8)
        try JSONDecoder().decode(ComputerStatus.self, from: valid).validate()
        for field in [valid.replacingOccurrences(of: "WeQ Remote", with: "Other"),
                      valid.replacingOccurrences(of: "true", with: "false")] {
            XCTAssertThrowsError(try JSONDecoder().decode(ComputerStatus.self, from: field).validate())
        }
    }
}

private extension Data {
    func replacingOccurrences(of old: String, with new: String) -> Data {
        Data(String(decoding: self, as: UTF8.self).replacingOccurrences(of: old, with: new).utf8)
    }
}
