import AppKit
import Carbon
import Darwin

func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
    do { try FileHandle.standardOutput.write(contentsOf: data + Data([10])) }
    catch { exit(0) }
}

final class VoicePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class MeterView: NSView {
    var level: CGFloat = 0 { didSet { needsDisplay = true } }
    var color = NSColor.systemGreen
    override func draw(_ dirtyRect: NSRect) {
        let heights: [CGFloat] = [0.35, 0.65, 1, 0.75, 0.45]
        for (index, height) in heights.enumerated() {
            let size = 3 + min(1, level * 4) * 19 * height
            let bar = NSRect(x: CGFloat(index) * 6, y: (bounds.height - size) / 2, width: 3, height: size)
            color.withAlphaComponent(level > 0.01 ? 1 : 0.45).setFill()
            NSBezierPath(roundedRect: bar, xRadius: 1.5, yRadius: 1.5).fill()
        }
    }
}

final class SurfaceView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 16, yRadius: 16)
        path.fill()
        NSColor(calibratedWhite: 0.32, alpha: 1).setStroke()
        path.lineWidth = 1; path.stroke()
    }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}

final class HUD: NSObject, NSWindowDelegate {
    let panel: VoicePanel
    let surface = SurfaceView()
    let meter = MeterView()
    let status = NSTextField(labelWithString: "Step Voice")
    let brand = NSTextField(labelWithString: "STEP VOICE · 当前会话")
    let caption = NSTextField(wrappingLabelWithString: "点击开始，与当前 StepCode 会话交流")
    let detail = NSTextField(wrappingLabelWithString: "不会自动开启麦克风")
    let shortcut = NSTextField(labelWithString: "⌥⌘V 展开 · ⌥⌘M 静音")
    let primary = NSButton(title: "开始语音", target: nil, action: nil)
    let interrupt = NSButton(title: "打断朗读", target: nil, action: nil)
    let end = NSButton(title: "结束", target: nil, action: nil)
    let mic = NSButton()
    let toggle = NSButton()
    let closeButton = NSButton()
    let settings = NSButton()
    var expanded = false
    var active = false
    var resizing = false
    var primaryAction = "start"
    var ending = false
    var positions: [String: [String: Double]] = [:]
    var persistTimer: Timer?
    var hotkeys: [EventHotKeyRef] = []
    var hotkeyHandler: EventHandlerRef?
    let preview: Bool
    let positionURL: URL

    init(preview: Bool = false, positionFile: String? = nil) {
        self.preview = preview
        positionURL = positionFile.map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".stepcode/step-voice/hud.json")
        panel = VoicePanel(contentRect: NSRect(x: 0, y: 0, width: 252, height: 48),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.title = "Step Voice 悬浮控制"
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.contentView = surface
        panel.setAccessibilityLabel("Step Voice 语音浮窗")
        buildViews()
        if !preview, let data = try? Data(contentsOf: positionURL), data.count < 16384,
           let saved = try? JSONDecoder().decode([String: [String: Double]].self, from: data) { positions = saved }
        restorePosition()
        if !preview { registerHotkeys() }
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    func buildViews() {
        for label in [status, brand, caption, detail, shortcut] {
            label.textColor = NSColor(calibratedWhite: 0.88, alpha: 1)
            label.isSelectable = false
            label.isEditable = false
            surface.addSubview(label)
        }
        status.font = .systemFont(ofSize: 13, weight: .medium)
        status.lineBreakMode = .byTruncatingTail
        brand.font = .systemFont(ofSize: 10, weight: .semibold)
        brand.textColor = NSColor(calibratedWhite: 0.7, alpha: 1)
        caption.font = .systemFont(ofSize: 14)
        caption.maximumNumberOfLines = 2; caption.lineBreakMode = .byTruncatingTail
        detail.font = .systemFont(ofSize: 11)
        detail.maximumNumberOfLines = 2; detail.lineBreakMode = .byTruncatingTail
        shortcut.font = .systemFont(ofSize: 10)
        shortcut.textColor = NSColor(calibratedWhite: 0.7, alpha: 1)
        surface.addSubview(meter)
        for button in [primary, interrupt, end, mic, toggle, closeButton, settings] {
            button.target = self
            button.font = .systemFont(ofSize: 12, weight: .medium)
            button.bezelStyle = .rounded
            button.appearance = NSAppearance(named: .darkAqua)
            surface.addSubview(button)
        }
        primary.action = #selector(primaryPressed)
        interrupt.action = #selector(interruptPressed)
        end.action = #selector(endPressed)
        icon(mic, "mic.fill", "开始语音", #selector(primaryPressed))
        icon(toggle, "chevron.up", "展开语音控制", #selector(togglePressed))
        icon(closeButton, "xmark", "结束通话并关闭浮窗", #selector(endPressed))
        icon(settings, "gearshape", "接入设置（打开 StepCode 设置弹窗）", #selector(settingsPressed))
        primary.toolTip = "开始或静音语音；也可用 /stepvoice start 或 /stepvoice mute"
        interrupt.toolTip = "只打断朗读，不取消编码任务；⌥⌘X"
        end.toolTip = "结束通话并关闭浮窗，不取消已提交的任务；⌥⌘E"
        layoutViews()
    }

    func icon(_ button: NSButton, _ symbol: String, _ label: String, _ action: Selector) {
        button.title = ""
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        button.imagePosition = .imageOnly
        button.isBordered = false
        button.contentTintColor = NSColor(calibratedWhite: 0.88, alpha: 1)
        button.toolTip = label
        button.setAccessibilityLabel(label)
        button.action = action
    }

    func layoutViews() {
        let width = panel.frame.width, height = panel.frame.height
        surface.frame = NSRect(x: 0, y: 0, width: width, height: height)
        meter.frame = NSRect(x: 16, y: height - 37, width: 30, height: 26)
        status.frame = NSRect(x: 54, y: height - 33, width: width - 166, height: 20)
        mic.frame = NSRect(x: width - 104, y: height - 40, width: 32, height: 32)
        toggle.frame = NSRect(x: width - 68, y: height - 40, width: 32, height: 32)
        closeButton.frame = NSRect(x: width - 36, y: height - 40, width: 32, height: 32)
        brand.frame = NSRect(x: 16, y: height - 62, width: width - 32, height: 14)
        caption.frame = NSRect(x: 16, y: height - 109, width: width - 32, height: 40)
        detail.frame = NSRect(x: 16, y: 65, width: width - 32, height: 30)
        primary.frame = NSRect(x: 12, y: 26, width: 124, height: 32)
        interrupt.frame = NSRect(x: 140, y: 26, width: 84, height: 32)
        end.frame = NSRect(x: 228, y: 26, width: 76, height: 32)
        settings.frame = NSRect(x: width - 44, y: 28, width: 32, height: 32)
        shortcut.frame = NSRect(x: 16, y: 8, width: width - 32, height: 14)
        for view in [brand, caption, detail, primary, interrupt, end, settings, shortcut] { view.isHidden = !expanded }
        toggle.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.up", accessibilityDescription: expanded ? "收起语音控制" : "展开语音控制")
        toggle.setAccessibilityLabel(expanded ? "收起语音控制" : "展开语音控制")
        toggle.toolTip = expanded ? "收起语音控制；⌥⌘V" : "展开语音控制；⌥⌘V"
        surface.needsDisplay = true
    }

    func update(_ state: [String: Any]) {
        func string(_ key: String, _ limit: Int) -> String { String((state[key] as? String ?? "").prefix(limit)) }
        active = state["active"] as? Bool ?? false
        primaryAction = state["primaryAction"] as? String ?? "start"
        if !["start", "mute", "setup"].contains(primaryAction) { primaryAction = "start" }
        status.stringValue = string("label", 30)
        primary.title = string("primary", 30)
        let muted = state["muted"] as? Bool ?? false
        let speaking = state["speaking"] as? Bool ?? false
        let value = state["micLevel"] as? Double ?? 0
        meter.level = value.isFinite ? CGFloat(max(0, min(1, value))) : 0
        let tone = state["tone"] as? String ?? "neutral"
        meter.color = ["green": NSColor.systemGreen, "blue": .systemBlue, "red": .systemRed, "amber": .systemOrange][tone] ?? .lightGray
        let captionText = string("caption", 160)
        caption.stringValue = captionText.isEmpty ? (active ? "正在连接当前会话，停顿后自动提交语音。" : "点击开始，用语音与当前 StepCode 会话交流。") : captionText
        detail.stringValue = string("detail", 240)
        detail.toolTip = detail.stringValue
        settings.isEnabled = !active
        interrupt.isEnabled = speaking
        let symbol = primaryAction == "setup" ? "gearshape" : active && !muted ? "mic.fill" : "mic.slash.fill"
        icon(mic, symbol, primary.title, #selector(primaryPressed))
        mic.contentTintColor = active && !muted ? .systemGreen : NSColor(calibratedWhite: 0.88, alpha: 1)
    }

    func show() { if !ending && !panel.isVisible { panel.orderFrontRegardless() } }
    func setExpanded(_ value: Bool) {
        expanded = value
        let size = NSSize(width: value ? 360 : 252, height: value ? 208 : 48)
        let old = panel.frame
        resizing = true
        panel.setFrame(clamped(NSRect(x: old.maxX - size.width, y: old.minY, width: size.width, height: size.height)), display: true)
        resizing = false
        layoutViews()
    }
    func clamped(_ frame: NSRect, on screen: NSScreen? = nil) -> NSRect {
        let area = (screen ?? panel.screen ?? NSScreen.main)?.visibleFrame ?? frame
        var result = frame
        result.origin.x = max(area.minX + 8, min(frame.origin.x, area.maxX - frame.width - 8))
        result.origin.y = max(area.minY + 8, min(frame.origin.y, area.maxY - frame.height - 8))
        return result
    }
    func screenID(_ screen: NSScreen) -> String {
        String((screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0)
    }
    func restorePosition() {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let area = screen.visibleFrame
        let saved = positions[screenID(screen)]
        let x = saved?["right"] ?? area.maxX - 24
        let y = saved?["bottom"] ?? area.minY + 24
        let frame = NSRect(x: x.isFinite ? x - 252 : area.maxX - 276, y: y.isFinite ? y : area.minY + 24, width: 252, height: 48)
        resizing = true; panel.setFrame(clamped(frame, on: screen), display: false); resizing = false
        layoutViews()
    }
    @objc func screensChanged() {
        resizing = true; panel.setFrame(clamped(panel.frame), display: true); resizing = false
        layoutViews()
    }
    func windowDidMove(_ notification: Notification) {
        guard !resizing, !preview, let screen = panel.screen else { return }
        positions[screenID(screen)] = ["right": Double(panel.frame.maxX), "bottom": Double(panel.frame.minY)]
        persistTimer?.invalidate()
        persistTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in self?.persistPosition() }
    }
    func persistPosition() {
        guard !preview, let data = try? JSONEncoder().encode(positions) else { return }
        let directory = positionURL.deletingLastPathComponent()
        // Do not follow a pre-existing symlink into another location.
        for path in [directory, positionURL] {
            if let attributes = try? FileManager.default.attributesOfItem(atPath: path.path), attributes[.type] as? FileAttributeType == .typeSymbolicLink { return }
        }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try data.write(to: positionURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: positionURL.path)
        } catch { /* Position persistence must never interrupt a live call. */ }
    }
    @objc func primaryPressed() { emit(["type": "action", "action": primaryAction]) }
    @objc func interruptPressed() { if interrupt.isEnabled { emit(["type": "action", "action": "interrupt"]) } }
    @objc func endPressed() { ending = true; emit(["type": "action", "action": "end"]); panel.orderOut(nil) }
    @objc func settingsPressed() { emit(["type": "action", "action": "setup"]) }
    @objc func togglePressed() { setExpanded(!expanded) }

    func registerHotkeys() {
        let handler: EventHandlerUPP = { _, event, userData in
            guard let event = event, let userData = userData else { return OSStatus(eventNotHandledErr) }
            var identifier = EventHotKeyID()
            let result = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                MemoryLayout<EventHotKeyID>.size, nil, &identifier)
            guard result == noErr else { return result }
            let hud = Unmanaged<HUD>.fromOpaque(userData).takeUnretainedValue()
            switch identifier.id {
            case 1: hud.togglePressed()
            case 2: if hud.active { hud.primaryPressed() }
            case 3: hud.interruptPressed()
            case 4: hud.endPressed()
            default: return OSStatus(eventNotHandledErr)
            }
            return noErr
        }
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        guard InstallEventHandler(GetApplicationEventTarget(), handler, 1, &event, Unmanaged.passUnretained(self).toOpaque(), &hotkeyHandler) == noErr else {
            shortcut.stringValue = "快捷键不可用；可用 /stepvoice 命令控制"; return
        }
        var unavailable = false
        for (id, key) in [(1, kVK_ANSI_V), (2, kVK_ANSI_M), (3, kVK_ANSI_X), (4, kVK_ANSI_E)] {
            var reference: EventHotKeyRef?
            let result = RegisterEventHotKey(UInt32(key), UInt32(optionKey | cmdKey), EventHotKeyID(signature: 0x53564844, id: UInt32(id)),
                GetApplicationEventTarget(), 0, &reference)
            if result == noErr, let reference = reference { hotkeys.append(reference) } else { unavailable = true }
        }
        if unavailable { shortcut.stringValue = "部分快捷键被占用；可用 /stepvoice 命令控制" }
    }
    func shutdown() {
        persistTimer?.invalidate(); persistPosition()
        for key in hotkeys { UnregisterEventHotKey(key) }
        if let handler = hotkeyHandler { RemoveEventHandler(handler) }
        panel.orderOut(nil)
        NSApp.terminate(nil)
    }

    func capture(_ url: URL) throws {
        surface.layoutSubtreeIfNeeded()
        surface.displayIfNeeded()
        guard let bitmap = surface.bitmapImageRepForCachingDisplay(in: surface.bounds) else { throw NSError(domain: "HUD", code: 1) }
        surface.cacheDisplay(in: surface.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw NSError(domain: "HUD", code: 2) }
        try png.write(to: url)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let arguments = CommandLine.arguments
let selfTest = arguments.count == 3 && arguments[1] == "--self-test"
let positionIndex = arguments.firstIndex(of: "--position-file")
let positionFile = positionIndex.flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
let hud = HUD(preview: selfTest, positionFile: positionFile)
let parentIndex = arguments.firstIndex(of: "--parent-pid")
let parentPID = parentIndex.flatMap { $0 + 1 < arguments.count ? pid_t(arguments[$0 + 1]) : nil }
var termination: DispatchSourceSignal?
var parentWatchdog: Timer?
if selfTest {
    let output = URL(fileURLWithPath: arguments[2], isDirectory: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        do {
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            let before = NSWorkspace.shared.frontmostApplication?.processIdentifier
            let ready: [String: Any] = ["label": "正在聆听", "tone": "green", "active": true, "muted": false, "speaking": false,
                "micLevel": 0.3, "primary": "静音麦克风", "primaryAction": "mute", "caption": "你：检查这个项目的测试，不要修改文件。", "detail": "StepCode · 正在执行你的语音任务"]
            hud.update(ready); hud.show()
            try hud.capture(output.appendingPathComponent("collapsed.png"))
            hud.toggle.performClick(nil)
            try hud.capture(output.appendingPathComponent("expanded.png"))
            hud.mic.performClick(nil)
            hud.update(["label": "语音出错", "tone": "red", "active": false, "primary": "重新开始", "primaryAction": "start",
                "detail": "麦克风权限未开启。请在系统设置 → 隐私与安全性 → 麦克风中允许 StepCode。"])
            try hud.capture(output.appendingPathComponent("error.png"))
            let unchanged = before == NSWorkspace.shared.frontmostApplication?.processIdentifier
            let passed = unchanged && !hud.panel.isKeyWindow && !hud.panel.canBecomeKey && !hud.panel.ignoresMouseEvents && hud.expanded
            emit(["type": "selftest", "ok": passed, "frontmostUnchanged": unchanged, "isKeyWindow": hud.panel.isKeyWindow,
                "clickThrough": hud.panel.ignoresMouseEvents, "permissionRequested": false])
            exit(passed ? 0 : 1)
        } catch { emit(["type": "selftest", "ok": false]); exit(1) }
    }
} else {
    emit(["type": "ready"])
    // Read bounded lines off the main thread; AppKit updates always stay on the main queue.
    DispatchQueue.global(qos: .userInitiated).async {
        var buffer = Data()
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 10) {
                let data = buffer.prefix(upTo: newline)
                buffer.removeSubrange(...newline)
                guard data.count <= 8192, let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
                DispatchQueue.main.async {
                    switch event["type"] as? String {
                    case "state": hud.update(event); hud.show()
                    case "show": hud.show()
                    case "close": hud.shutdown()
                    default: break
                    }
                }
            }
            if buffer.count > 8192 { break }
        }
        DispatchQueue.main.async { hud.shutdown() }
    }
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    source.setEventHandler { hud.shutdown() }
    source.resume()
    termination = source
    // A crashed or killed plugin process must not leave a floating indicator behind.
    if let parentPID = parentPID {
        let watchdog = Timer(timeInterval: 2, repeats: true) { _ in
            let orphaned = getppid() == 1
            let gone = kill(parentPID, 0) != 0 && errno == ESRCH
            if orphaned || gone { hud.shutdown() }
        }
        RunLoop.main.add(watchdog, forMode: .common)
        parentWatchdog = watchdog
    }
}
app.run()
