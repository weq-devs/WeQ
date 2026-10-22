import AVFoundation
import SwiftUI
import VisionKit

@main
struct WeQRemoteApp: App {
    @StateObject private var network: EmbeddedNetwork
    @StateObject private var model: RemoteModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let network = EmbeddedNetwork()
        _network = StateObject(wrappedValue: network)
        _model = StateObject(wrappedValue: RemoteModel(network: network))
    }

    var body: some Scene {
        WindowGroup {
            RemoteView(model: model, network: network)
                .onOpenURL { model.invitationText = $0.absoluteString }
                .task(id: "\(scenePhase)-\(network.enabled)") {
                    if scenePhase == .background {
                        model.disconnect()
                        await network.stop(disable: false)
                    } else if scenePhase == .active {
                        while !Task.isCancelled {
                            await network.refresh()
                            if !network.enabled || network.connected || network.loginURL != nil { return }
                            do { try await Task.sleep(for: .seconds(2)) } catch { return }
                        }
                    }
                }
        }
    }
}

struct RemoteView: View {
    @ObservedObject var model: RemoteModel
    @ObservedObject var network: EmbeddedNetwork
    @Environment(\.openURL) private var openURL
    @State private var scanning = false
    @State private var cameraError = false

    var body: some View {
        NavigationStack {
            Form {
                Section("网络") {
                    if EmbeddedNetwork.integrationControl != nil { Text("本机 TS 集成测试").font(.caption).foregroundStyle(.secondary) }
                    LabeledContent("App 内网络", value: model.testMode ? "回环集成测试" : network.message)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("App 内网络")
                        .accessibilityValue(model.testMode ? "回环集成测试" : network.message)
                        .accessibilityIdentifier("networkState")
                    if let address = network.address { LabeledContent("手机地址", value: address).font(.caption).textSelection(.enabled) }
                    if let login = network.loginURL {
                        Button { openURL(login) } label: { Label("登录 Tailscale", systemImage: "arrow.up.right.square") }
                    }
                    if !model.testMode {
                        Button {
                            Task {
                                if network.enabled { model.disconnect(); await network.stop() }
                                else { await network.start() }
                            }
                        } label: { Label(network.enabled ? "断开网络" : "连接网络", systemImage: network.enabled ? "network.slash" : "network") }
                    }
                }
                if !model.paired && model.code == nil {
                    Section("配对电脑") {
                        TextField("配对链接", text: $model.invitationText, axis: .vertical)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .lineLimit(1...3).privacySensitive().accessibilityIdentifier("pairingLink")
                        HStack {
                            Button { Task { await scan() } } label: { Label("扫码", systemImage: "qrcode.viewfinder") }
                            Spacer()
                            PasteButton(payloadType: String.self) { model.invitationText = $0.first ?? "" }
                                .labelStyle(.iconOnly)
                        }.buttonStyle(.borderless)
                        Button { Task { await model.pair() } } label: { Label("配对电脑", systemImage: "link") }
                            .disabled(model.busy || model.invitationText.isEmpty || (!network.connected && !model.testMode))
                            .accessibilityIdentifier("pairComputer")
                    }
                }
                Section("电脑") {
                    Label(model.message, systemImage: model.connected ? "desktopcomputer" : "desktopcomputer.trianglebadge.exclamationmark")
                        .foregroundStyle(model.connected ? Color.green : Color.primary)
                        .accessibilityIdentifier("computerState")
                    if let host = model.computerAddress { LabeledContent("地址", value: host).font(.caption) }
                    if let code = model.code {
                        LabeledContent("校验码") { Text(code).font(.title2.monospacedDigit()).textSelection(.enabled) }
                        Text("等待电脑批准").foregroundStyle(.secondary)
                    }
                    if let latency = model.latency { LabeledContent("请求耗时", value: "\(latency) ms") }
                    if let time = model.checkedAt { LabeledContent("最近验证") { Text(time, style: .time) } }
                    if model.paired {
                        Button { Task { await model.refresh() } } label: { Label("验证连通", systemImage: "arrow.clockwise") }
                            .disabled(model.busy).accessibilityIdentifier("verifyConnection")
                    }
                    if model.code != nil || model.connected {
                        Button("断开电脑", role: .destructive) { model.disconnect() }
                    }
                    if model.busy { ProgressView().accessibilityLabel("请求进行中") }
                    if let error = model.error { Text(error).foregroundStyle(.red).accessibilityIdentifier("connectionError") }
                }
            }
            .navigationTitle("WeQ Remote")
            .task { if EmbeddedNetwork.integrationControl != nil { await network.start() } }
            .sheet(isPresented: $scanning) {
                NavigationStack {
                    ScannerView(onScan: { model.invitationText = $0; scanning = false }, onError: { scanning = false; cameraError = true })
                        .ignoresSafeArea(edges: .bottom)
                        .navigationTitle("扫描配对码").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { scanning = false } } }
                }
            }
            .alert("相机不可用", isPresented: $cameraError) { Button("好", role: .cancel) {} }
                message: { Text("可在系统设置中允许相机访问，或粘贴电脑的配对链接。") }
        }
    }

    private func scan() async {
        let allowed = await AVCaptureDevice.requestAccess(for: .video)
        if allowed && DataScannerViewController.isSupported && DataScannerViewController.isAvailable { scanning = true }
        else { cameraError = true }
    }
}
