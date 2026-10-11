import Foundation
import AVFoundation
import Darwin

let ioLock = NSLock()
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    ioLock.lock()
    defer { ioLock.unlock() }
    do { try FileHandle.standardOutput.write(contentsOf: data + Data([10])) }
    catch { exit(0) }
}

func fail(_ message: String) {
    emit(["type": "error", "message": message])
    exit(1)
}

func pcmBytes(_ buffer: AVAudioPCMBuffer) -> Data {
    let first = buffer.audioBufferList.pointee.mBuffers
    guard let pointer = first.mData else { return Data() }
    return Data(bytes: pointer, count: Int(buffer.frameLength) * 2)
}

func convert(_ input: AVAudioPCMBuffer, using converter: AVAudioConverter, outputFormat: AVAudioFormat) throws -> AVAudioPCMBuffer {
    let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * outputFormat.sampleRate / input.format.sampleRate) + 64)
    guard let result = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
        throw NSError(domain: "StepVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法创建音频缓冲区"])
    }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: result, error: &error) { _, inputStatus in
        if supplied { inputStatus.pointee = .noDataNow; return nil }
        supplied = true
        inputStatus.pointee = .haveData
        return input
    }
    if status == .error { throw error ?? NSError(domain: "StepVoice", code: 2) }
    return result
}

if CommandLine.arguments.contains("--self-test") {
    // Offline conversion only: no device, engine, or microphone permission request.
    let inputFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
    let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: 4800)!
    input.frameLength = 4800
    for index in 0..<4800 { input.floatChannelData![0][index] = Float(sin(Double(index) * 0.04) * 0.4) }
    do {
        let converter = AVAudioConverter(from: inputFormat, to: outputFormat)!
        let result = try convert(input, using: converter, outputFormat: outputFormat)
        let tail = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 1024)!
        var drainError: NSError?
        let drainStatus = converter.convert(to: tail, error: &drainError) { _, status in status.pointee = .endOfStream; return nil }
        if drainStatus == .error { throw drainError ?? NSError(domain: "StepVoice", code: 4) }
        let bytes = pcmBytes(result) + pcmBytes(tail)
        let frames = result.frameLength + tail.frameLength
        let passed = frames == 2400 && bytes.count == 4800
        emit(["type": "selftest", "ok": passed, "sampleRate": 24000, "frames": frames, "bytes": bytes.count, "byteOrder": "little-endian", "permissionRequested": false])
        exit(passed ? 0 : 1)
    } catch { fail("离线 PCM 转换失败：\(error.localizedDescription)") }
}

final class VoiceAudio {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let captureFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
    let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
    let captureLock = NSLock()
    var muted = false
    var pendingPCM = Data()
    var playbackEpoch = 0
    var pendingFrames = 0
    var stopped = false
    var installedTap = false

    func start() throws {
        // Voice processing supplies echo cancellation when the device supports it.
        do { try engine.inputNode.setVoiceProcessingEnabled(true) }
        catch { emit(["type": "notice", "message": "设备未启用系统回声消除，建议使用耳机。"] ) }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0, let converter = AVAudioConverter(from: format, to: captureFormat) else {
            throw NSError(domain: "StepVoice", code: 3, userInfo: [NSLocalizedDescriptionKey: "没有可用麦克风，请检查系统声音输入设备"])
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            do {
                let converted = try convert(buffer, using: converter, outputFormat: self.captureFormat)
                self.captureLock.lock()
                defer { self.captureLock.unlock() }
                if self.muted || self.stopped { return }
                self.pendingPCM.append(pcmBytes(converted))
                // 40 ms frames keep the IPC/upstream rate at 25 frames per second.
                while self.pendingPCM.count >= 1920 {
                    let frame = self.pendingPCM.prefix(1920)
                    self.pendingPCM.removeFirst(1920)
                    var sum = 0.0
                    frame.withUnsafeBytes { bytes in
                        for index in stride(from: 0, to: frame.count, by: 2) {
                            let bits = UInt16(bytes[index]) | (UInt16(bytes[index + 1]) << 8)
                            let sample = Double(Int16(bitPattern: bits)) / 32768.0
                            sum += sample * sample
                        }
                    }
                    emit(["type": "level", "value": sqrt(sum / 960.0)])
                    emit(["type": "audio", "audio": frame.base64EncodedString(), "sampleRate": 24000])
                }
            } catch { emit(["type": "error", "message": "麦克风转换失败：\(error.localizedDescription)"]) }
        }
        installedTap = true
        engine.prepare()
        try engine.start()
        player.play()
        emit(["type": "ready", "inputSampleRate": format.sampleRate, "sampleRate": 24000, "voiceProcessing": input.isVoiceProcessingEnabled])
    }

    func setMuted(_ value: Bool) {
        captureLock.lock()
        muted = value
        pendingPCM.removeAll(keepingCapacity: true)
        captureLock.unlock()
        if value { emit(["type": "level", "value": 0]) }
    }

    func clear() {
        playbackEpoch += 1
        pendingFrames = 0
        player.stop()
        if engine.isRunning { player.play() }
        emit(["type": "playback", "active": false])
    }

    func play(_ audio: String, rate: Double) {
        guard !stopped, rate == 24000, let data = Data(base64Encoded: audio), data.count > 0, data.count % 2 == 0, data.count <= 262144 else {
            emit(["type": "error", "message": "播放音频必须是 24 kHz 单声道 PCM16"])
            return
        }
        let frameCount = data.count / 2
        guard pendingFrames + frameCount < 24000 * 30 else {
            clear()
            emit(["type": "error", "message": "待播放音频超过 30 秒，已清空，请继续对话。"])
            return
        }
        let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: AVAudioFrameCount(frameCount))!
        buffer.frameLength = AVAudioFrameCount(frameCount)
        data.withUnsafeBytes { bytes in
            for index in 0..<frameCount {
                let bits = UInt16(bytes[index * 2]) | (UInt16(bytes[index * 2 + 1]) << 8)
                buffer.floatChannelData![0][index] = Float(Int16(bitPattern: bits)) / 32768.0
            }
        }
        let epoch = playbackEpoch
        pendingFrames += frameCount
        emit(["type": "playback", "active": true])
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, epoch == self.playbackEpoch else { return }
                self.pendingFrames = max(0, self.pendingFrames - frameCount)
                if self.pendingFrames == 0 { emit(["type": "playback", "active": false]) }
            }
        }
    }

    func stop() {
        if stopped { return }
        captureLock.lock()
        stopped = true
        pendingPCM.removeAll()
        captureLock.unlock()
        clear()
        if installedTap { engine.inputNode.removeTap(onBus: 0); installedTap = false }
        engine.stop()
        emit(["type": "closed"])
        exit(0)
    }
}

let audio = VoiceAudio()
func startAuthorizedAudio() {
    do { try audio.start() }
    catch { fail("无法启动音频：\(error.localizedDescription)") }
}
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized: startAuthorizedAudio()
case .notDetermined:
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        DispatchQueue.main.async {
            if granted { startAuthorizedAudio() }
            else { fail("麦克风权限未开启。请在系统设置 → 隐私与安全性 → 麦克风中允许当前终端应用。") }
        }
    }
default: fail("麦克风权限未开启。请在系统设置 → 隐私与安全性 → 麦克风中允许当前终端应用。")
}

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard line.utf8.count < 400000, let bytes = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            switch command["type"] as? String {
            case "play": audio.play(command["audio"] as? String ?? "", rate: command["sampleRate"] as? Double ?? 24000)
            case "clear": audio.clear()
            case "mute": audio.setMuted(command["muted"] as? Bool ?? false)
            case "stop": audio.stop()
            default: break
            }
        }
    }
    DispatchQueue.main.async { audio.stop() }
}
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler { audio.stop() }
termination.resume()
RunLoop.main.run()
