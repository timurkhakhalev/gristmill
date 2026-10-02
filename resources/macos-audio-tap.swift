import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

@available(macOS 14.2, *)
struct Config {
    let sampleRate: Double
    let chunkMilliseconds: Int
}

@available(macOS 14.2, *)
final class AudioTapCapture {
    private let config: Config
    private let targetFormat: AVAudioFormat
    private let chunkBytes: Int
    private let ioQueue = DispatchQueue(label: "com.khakhalev.gristmill.audio-tap")
    private let listenerQueue = DispatchQueue(label: "com.khakhalev.gristmill.audio-tap.listeners")

    private var tapID: AudioObjectID = 0
    private var aggregateDeviceID: AudioObjectID = 0
    private var ioProcID: AudioDeviceIOProcID?
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private var pendingPCM = Data()
    private var stopping = false
    private let generation = UUID().uuidString
    private var convertedFrames: Int64 = 0
    private var pendingPCMStartFrame: Int64 = 0
    private var hasPendingPCMStartFrame = false
    private var monotonicOriginNs: UInt64?
    private var startMessageSent = false
    private var clockStartFrame: Int64 = 0
    private var clockHostStart: UInt64?
    private var clockHostEnd: UInt64?
    private var clockReason: String?
    private var clockTimebase = mach_timebase_info_data_t()
    private let metadataQueue = DispatchQueue(label: "com.khakhalev.gristmill.audio-tap.clock")
    private let metadataSlots = DispatchSemaphore(value: 32)
    private var clockOverflowReported = false


    private typealias Listener = (
        object: AudioObjectID,
        address: AudioObjectPropertyAddress,
        block: AudioObjectPropertyListenerBlock
    )
    private var listeners: [Listener] = []
    private var invalidationWorkItem: DispatchWorkItem?
    private var invalidationReported = false

    init(config: Config) {
        self.config = config
        mach_timebase_info(&clockTimebase)
        self.targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: config.sampleRate,
            channels: 1,
            interleaved: true
        )!
        self.chunkBytes = max(2, Int(config.sampleRate * Double(config.chunkMilliseconds) / 1000.0) * 2)
    }

    func start() throws {
        let tapDescription = CATapDescription()
        tapDescription.name = "gristmill-audio-tap"
        tapDescription.uuid = UUID()
        tapDescription.processes = []
        tapDescription.isMono = true
        tapDescription.isExclusive = true
        tapDescription.isMixdown = true
        tapDescription.isPrivate = true
        tapDescription.muteBehavior = .unmuted

        var newTapID = AudioObjectID()
        var status = AudioHardwareCreateProcessTap(tapDescription, &newTapID)
        guard status == noErr else {
            throw makeError("Failed to create process tap", status: status, operation: "create_process_tap")
        }
        tapID = newTapID

        let tapUID = try getTapUID()
        try createAggregateDevice(tapUID: tapUID)
        try waitForAggregateDeviceReady()
        try configureConverter()
        try registerIOProc()

        status = AudioDeviceStart(aggregateDeviceID, ioProcID)
        guard status == noErr else {
            throw makeError("Failed to start aggregate device", status: status, operation: "start_device")
        }

        installInvalidationListeners()

    }

    func handleProbe(nonce: String) {
        guard !nonce.isEmpty, nonce.count <= 64 else { return }
        let receiveNs = machAbsoluteNowNs()
        let frame = ioQueue.sync { convertedFrames }
        let sendNs = machAbsoluteNowNs()
        emit(event: [
            "type": "probe",
            "nonce": nonce,
            "helperReceiveNs": String(receiveNs),
            "helperSendNs": String(sendNs),
            "helperGeneration": generation,
            "helperFrame": max(0, frame),
        ])
    }

    func stop() {
        if stopping {
            return
        }
        stopping = true
        removeInvalidationListeners()

        if aggregateDeviceID != 0 {
            AudioDeviceStop(aggregateDeviceID, ioProcID)
        }
        if let ioProcID {
            AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
            self.ioProcID = nil
        }
        if aggregateDeviceID != 0 {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = 0
        }
        if tapID != 0 {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = 0
        }

        ioQueue.sync {
            flushPendingPCM()
            flushClock()
        }
        metadataQueue.sync {}
        emit(event: ["type": "stop"])
    }

    private func createAggregateDevice(tapUID: String) throws {
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Gristmill Audio Tap",
            kAudioAggregateDeviceUIDKey: "com.khakhalev.gristmill.audio-tap.\(UUID().uuidString)",
            kAudioAggregateDeviceSubDeviceListKey: [],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID]],
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
        ]

        var deviceID = AudioObjectID()
        let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &deviceID)
        guard status == noErr else {
            throw makeError("Failed to create aggregate device", status: status, operation: "create_aggregate_device")
        }
        aggregateDeviceID = deviceID
    }

    private func isAggregateDeviceAlive() -> Bool {
        guard aggregateDeviceID != 0 else {
            return false
        }

        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var isAlive: UInt32 = 0
        var dataSize = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(
            aggregateDeviceID,
            &address,
            0,
            nil,
            &dataSize,
            &isAlive
        )
        return status == noErr && isAlive != 0
    }

    private func waitForAggregateDeviceReady() throws {
        for _ in 0..<20 {
            if isAggregateDeviceAlive() {
                return
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        throw makeError("Aggregate device did not become ready", operation: "wait_for_device")
    }

    // The tap is built once and never follows the system afterwards, so a route
    // change or a disappearing device can stop delivery with the process still
    // healthy. These listeners turn that into a warning the host can act on.
    private func installInvalidationListeners() {
        addInvalidationListener(
            object: AudioObjectID(kAudioObjectSystemObject),
            selector: kAudioHardwarePropertyDefaultOutputDevice,
            reason: "default_output_changed"
        )
        // kAudioHardwarePropertyDevices is deliberately not observed. Our
        // aggregate has an empty sub-device list, so it stays alive when a
        // physical device disappears and the report would always be suppressed;
        // meanwhile the notification fires on unrelated device churn from any
        // app, and sharing the coalescing window would cancel a pending
        // default_output_changed report that does matter.
        addInvalidationListener(
            object: aggregateDeviceID,
            selector: kAudioDevicePropertyDeviceIsAlive,
            reason: "device_not_alive"
        )
    }

    private func addInvalidationListener(
        object: AudioObjectID,
        selector: AudioObjectPropertySelector,
        reason: String
    ) {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.scheduleInvalidationReport(reason: reason)
        }

        let status = AudioObjectAddPropertyListenerBlock(object, &address, listenerQueue, block)
        guard status == noErr else {
            // Capture still works, it just loses this detection path, so report
            // and carry on rather than failing the whole session.
            emit(event: [
                "type": "warning",
                "code": "listener_unavailable",
                "reason": reason,
                "message": "Failed to observe \(reason): \(Int(status))",
            ])
            return
        }

        listeners.append((object: object, address: address, block: block))
    }

    private func removeInvalidationListeners() {
        listenerQueue.sync {
            invalidationWorkItem?.cancel()
            invalidationWorkItem = nil
        }

        for listener in listeners {
            var address = listener.address
            AudioObjectRemovePropertyListenerBlock(
                listener.object,
                &address,
                listenerQueue,
                listener.block
            )
        }
        listeners.removeAll()
    }

    // A route change fires several notifications in a burst, so coalesce them
    // into one report. Runs on listenerQueue, never on the IO thread.
    private func scheduleInvalidationReport(reason: String) {
        invalidationWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.reportInvalidation(reason: reason)
        }
        invalidationWorkItem = workItem
        listenerQueue.asyncAfter(deadline: .now() + 0.3, execute: workItem)
    }

    private func reportInvalidation(reason: String) {
        guard !invalidationReported, !stopping else {
            return
        }

        invalidationReported = true
        emit(event: [
            "type": "warning",
            "code": "device_invalidated",
            "reason": reason,
            "message": "System audio device changed (\(reason)); capture may have stopped.",
        ])
    }

    private func configureConverter() throws {
        var asbd = AudioStreamBasicDescription()
        var dataSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &dataSize, &asbd)
        guard status == noErr else {
            throw makeError("Failed to get tap format", status: status, operation: "get_tap_format")
        }

        guard let sourceFormat = AVAudioFormat(streamDescription: &asbd) else {
            throw makeError("Failed to build source audio format", operation: "source_format")
        }
        guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
            throw makeError("Failed to create audio converter", operation: "create_converter")
        }

        self.sourceFormat = sourceFormat
        self.converter = converter
    }

    private func registerIOProc() throws {
        guard let sourceFormat, let converter else {
            throw makeError("Audio converter is not configured", operation: "register_ioproc")
        }

        var procID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcIDWithBlock(
            &procID,
            aggregateDeviceID,
            ioQueue
        ) { [weak self] _, inputData, inputTime, _, _ in
            guard let self, !self.stopping else {
                return
            }
            self.processInput(inputData, inputTime: inputTime.pointee, sourceFormat: sourceFormat, converter: converter)
        }

        guard status == noErr, let procID else {
            throw makeError("Failed to create IO proc", status: status, operation: "create_ioproc")
        }

        ioProcID = procID
    }

    private func processInput(
        _ inputData: UnsafePointer<AudioBufferList>,
        inputTime: AudioTimeStamp,
        sourceFormat: AVAudioFormat,
        converter: AVAudioConverter
    ) {
        let inputBufferList = UnsafeMutablePointer(mutating: inputData)
        guard
            let sourceBuffer = AVAudioPCMBuffer(
                pcmFormat: sourceFormat,
                bufferListNoCopy: inputBufferList,
                deallocator: nil
            )
        else {
            return
        }

        let sourceRate = max(sourceFormat.sampleRate, 1)
        let targetCapacity = AVAudioFrameCount(
            ceil(Double(sourceBuffer.frameLength) * targetFormat.sampleRate / sourceRate)
        ) + 32

        guard
            let outputBuffer = AVAudioPCMBuffer(
                pcmFormat: targetFormat,
                frameCapacity: max(targetCapacity, 32)
            )
        else {
            return
        }

        var didProvideInput = false
        var error: NSError?
        let status = converter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if didProvideInput {
                outStatus.pointee = .noDataNow
                return nil
            }
            didProvideInput = true
            outStatus.pointee = .haveData
            return sourceBuffer
        }

        if let error {
            emit(event: [
                "type": "error",
                "code": "convert_failed",
                "message": error.localizedDescription,
            ])
            return
        }

        guard status == .haveData || status == .inputRanDry else {
            return
        }

        let audioBuffer = outputBuffer.audioBufferList.pointee.mBuffers
        guard let data = audioBuffer.mData, audioBuffer.mDataByteSize > 0 else {
            return
        }

        if !hasPendingPCMStartFrame {
            pendingPCMStartFrame = convertedFrames
            hasPendingPCMStartFrame = true
        }
        recordClock(inputTime: inputTime, sourceFrames: sourceBuffer.frameLength,
                    sourceRate: sourceRate, outputFrames: outputBuffer.frameLength)
        pendingPCM.append(data.assumingMemoryBound(to: UInt8.self), count: Int(audioBuffer.mDataByteSize))
        flushFullChunks()
    }

    private func hostNS(_ ticks: UInt64) -> UInt64 {
        let numer = UInt64(clockTimebase.numer)
        let denom = UInt64(clockTimebase.denom)
        return ticks / denom * numer + ticks % denom * numer / denom
    }

    private func recordClock(inputTime: AudioTimeStamp, sourceFrames: AVAudioFrameCount,
                             sourceRate: Double, outputFrames: AVAudioFrameCount) {
        let valid = inputTime.mFlags.contains(.hostTimeValid) && inputTime.mHostTime > 0
        let hostStart = valid ? hostNS(inputTime.mHostTime) : nil
        let hostEnd = hostStart.map { $0 + UInt64(Double(sourceFrames) / sourceRate * 1e9) }
        // A gap or invalid timestamp closes a range; no interpolation across it.
        // The tolerance is one input sample of timestamp rounding, not a measured
        // converter/Zoom latency budget. Those remain uncalibrated.
        let gap = clockHostEnd != nil && hostStart != nil &&
            abs(Double(hostStart!) - Double(clockHostEnd!)) > 1e9 / sourceRate
        if gap || (clockHostStart == nil) != (hostStart == nil) { flushClock() }
        if convertedFrames == clockStartFrame {
            clockHostStart = hostStart
            clockReason = valid ? nil : "invalid-host-time"
        }
        if !startMessageSent, let hostStart {
            monotonicOriginNs = hostStart
            startMessageSent = true
            emit(event: [
                "type": "start",
                "generation": generation,
                "sampleRate": Int(config.sampleRate),
                "channels": 1,
                "bitsPerChannel": 16,
                "monotonicOriginNs": String(hostStart),
                "originFrame": convertedFrames,
            ])
        }
        clockHostEnd = hostEnd
        convertedFrames += Int64(outputFrames)
        if convertedFrames - clockStartFrame >= Int64(config.sampleRate) { flushClock() }
    }

    private func flushClock() {
        guard convertedFrames > clockStartFrame else { return }
        let event: [String: Any] = [
            "type": "clock", "generation": generation,
            "startFrame": clockStartFrame, "endFrame": convertedFrames,
            "hostStartNs": clockHostStart.map { String($0) } as Any? ?? NSNull(),
            "hostEndNs": clockHostEnd.map { String($0) } as Any? ?? NSNull(),
            "timebaseNumer": clockTimebase.numer, "timebaseDenom": clockTimebase.denom,
            "conversion": "uncalibrated", "reason": clockReason as Any? ?? NSNull(),
        ]
        clockStartFrame = convertedFrames
        clockHostStart = nil
        clockHostEnd = nil
        clockReason = nil
        guard metadataSlots.wait(timeout: .now()) == .success else {
            if !clockOverflowReported {
                clockOverflowReported = true
                metadataQueue.async {
                    emit(event: ["type": "warning", "code": "clock_queue_overflow"])
                }
            }
            return
        }
        metadataQueue.async { [self] in
            emit(event: event)
            metadataSlots.signal()
        }
    }

    private func flushFullChunks() {
        while pendingPCM.count >= chunkBytes {
            let chunk = pendingPCM.prefix(chunkBytes)
            let frameCount = chunkBytes / 2
            emit(event: [
                "type": "pcm",
                "frameStart": pendingPCMStartFrame,
                "frameCount": frameCount,
            ])
            chunk.withUnsafeBytes { rawBuffer in
                guard let baseAddress = rawBuffer.baseAddress else {
                    return
                }
                writeAll(fd: STDOUT_FILENO, buffer: baseAddress, count: rawBuffer.count)
            }
            pendingPCM.removeFirst(chunkBytes)
            pendingPCMStartFrame += Int64(frameCount)
            hasPendingPCMStartFrame = !pendingPCM.isEmpty
        }
    }

    private func flushPendingPCM() {
        guard !pendingPCM.isEmpty else {
            return
        }

        let frameCount = pendingPCM.count / 2
        emit(event: [
            "type": "pcm",
            "frameStart": pendingPCMStartFrame,
            "frameCount": frameCount,
        ])

        pendingPCM.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else {
                return
            }
            writeAll(fd: STDOUT_FILENO, buffer: baseAddress, count: rawBuffer.count)
        }
        pendingPCM.removeAll(keepingCapacity: false)
        hasPendingPCMStartFrame = false
    }

    private func getTapUID() throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var unmanagedUID: Unmanaged<CFString>?
        var dataSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &unmanagedUID) { pointer in
            AudioObjectGetPropertyData(tapID, &address, 0, nil, &dataSize, pointer)
        }
        guard status == noErr, let unmanagedUID else {
            throw makeError("Failed to get tap UID", status: status, operation: "get_tap_uid")
        }
        return unmanagedUID.takeRetainedValue() as String
    }
}

@available(macOS 14.2, *)
func parseConfig() -> Config {
    var sampleRate = 24_000.0
    var chunkMilliseconds = 100
    let args = Array(CommandLine.arguments.dropFirst())
    var index = 0

    while index < args.count {
        switch args[index] {
        case "--sample-rate":
            if index + 1 < args.count, let value = Double(args[index + 1]), value > 0 {
                sampleRate = value
            }
            index += 2
        case "--chunk-ms":
            if index + 1 < args.count, let value = Int(args[index + 1]), value > 0 {
                chunkMilliseconds = value
            }
            index += 2
        default:
            index += 1
        }
    }

    return Config(sampleRate: sampleRate, chunkMilliseconds: chunkMilliseconds)
}

// Events are emitted from the main thread and, since the invalidation
// listeners landed, from the listener queue too. The host parses stderr a line
// at a time, so two writers interleaving would produce a line it drops as
// malformed; serialising here keeps every event whole.
let emitQueue = DispatchQueue(label: "com.khakhalev.gristmill.audio-tap.emit")

func emit(event: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(event) else {
        return
    }

    guard let data = try? JSONSerialization.data(withJSONObject: event) else {
        return
    }

    emitQueue.sync {
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data([0x0a]))
    }
}

func machAbsoluteNowNs() -> UInt64 {
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    let ticks = mach_absolute_time()
    let numer = UInt64(timebase.numer)
    let denom = UInt64(timebase.denom)
    return ticks / denom * numer + ticks % denom * numer / denom
}

func readProbeRequests(_ capture: AudioTapCapture) {
    let maxLineBytes = 1024
    var line = Data()
    var discardingLine = false
    var buffer = [UInt8](repeating: 0, count: 256)
    while true {
        let byteCount = buffer.withUnsafeMutableBytes { rawBuffer -> Int in
            guard let baseAddress = rawBuffer.baseAddress else { return 0 }
            return Darwin.read(STDIN_FILENO, baseAddress, rawBuffer.count)
        }
        if byteCount == 0 { return }
        if byteCount < 0 {
            if errno == EINTR { continue }
            return
        }
        for byte in buffer.prefix(byteCount) {
            if byte == 0x0a {
                if discardingLine {
                    emit(event: ["type": "warning", "code": "probe_request_too_large"])
                } else if !line.isEmpty {
                    guard
                        let object = try? JSONSerialization.jsonObject(with: line),
                        let request = object as? [String: Any],
                        request.count == 2,
                        request["type"] as? String == "probe",
                        let nonce = request["nonce"] as? String,
                        UUID(uuidString: nonce) != nil
                    else {
                        emit(event: ["type": "warning", "code": "probe_invalid_request"])
                        line.removeAll(keepingCapacity: true)
                        continue
                    }
                    capture.handleProbe(nonce: nonce)
                }
                line.removeAll(keepingCapacity: true)
                discardingLine = false
            } else if !discardingLine {
                if line.count >= maxLineBytes {
                    line.removeAll(keepingCapacity: false)
                    discardingLine = true
                } else {
                    line.append(byte)
                }
            }
        }
    }
}

func writeAll(fd: Int32, buffer: UnsafeRawPointer, count: Int) {
    var written = 0
    while written < count {
        let result = Darwin.write(fd, buffer.advanced(by: written), count - written)
        if result <= 0 {
            break
        }
        written += result
    }
}

func makeError(
    _ message: String,
    status: OSStatus? = nil,
    operation: String,
    code: String? = nil
) -> NSError {
    var userInfo: [String: Any] = [NSLocalizedDescriptionKey: message]
    let resolvedCode = code ?? inferErrorCode(status: status, operation: operation)
    userInfo["AudioTapErrorCode"] = resolvedCode
    userInfo["AudioTapOperation"] = operation
    if let status {
        userInfo["AudioTapStatus"] = Int(status)
        userInfo["NSLocalizedFailureReasonErrorKey"] = "\(message): \(Int(status))"
    }
    return NSError(domain: "GristmillAudioTap", code: Int(status ?? -1), userInfo: userInfo)
}

func inferErrorCode(status: OSStatus?, operation: String) -> String {
    if status == kAudioHardwareIllegalOperationError {
        return "permission_denied"
    }
    return operation
}

// Reads the real TCC grant (attributed to the responsible app) without
// prompting, so the host never trusts a stale cached answer.
func preflightAudioCapturePermission() -> String {
    typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
    guard
        let handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
        let symbol = dlsym(handle, "TCCAccessPreflight")
    else {
        return "unknown"
    }
    switch unsafeBitCast(symbol, to: Preflight.self)("kTCCServiceAudioCapture" as CFString, nil) {
    case 0: return "granted"
    case 1: return "denied"
    default: return "unknown"
    }
}

if CommandLine.arguments.contains("--check-permission") {
    emit(event: ["type": "permission", "status": preflightAudioCapturePermission()])
    exit(0)
}

if #available(macOS 14.2, *) {
    let capture = AudioTapCapture(config: parseConfig())
    DispatchQueue.global(qos: .utility).async { readProbeRequests(capture) }
    var signalSources: [DispatchSourceSignal] = []

    func stopAndExit(_ code: Int32) -> Never {
        capture.stop()
        exit(code)
    }

    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)

    for signalValue in [SIGINT, SIGTERM] {
        let source = DispatchSource.makeSignalSource(signal: signalValue, queue: .main)
        source.setEventHandler {
            stopAndExit(0)
        }
        source.resume()
        signalSources.append(source)
    }

    do {
        try capture.start()
        dispatchMain()
    } catch {
        let nsError = error as NSError
        emit(event: [
            "type": "error",
            "code": nsError.userInfo["AudioTapErrorCode"] as? String ?? "start_failed",
            "message": nsError.localizedDescription,
            "operation": nsError.userInfo["AudioTapOperation"] as? String ?? "start",
            "status": nsError.userInfo["AudioTapStatus"] as? Int ?? nsError.code,
        ])
        capture.stop()
        exit(1)
    }
} else {
    emit(event: [
        "type": "error",
        "code": "unsupported_os",
        "message": "macOS 14.2 or later is required",
    ])
    exit(1)
}
