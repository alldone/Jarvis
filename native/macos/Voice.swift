import Foundation
import AVFoundation
import Speech
import AppKit
import CoreGraphics

// Only read Space's physical state after the terminal has requested a recording.
// No global keyboard event tap, key log, or background microphone capture.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let text = String(data: data, encoding: .utf8) else { return }
    print(text)
    fflush(stdout)
}

let arguments = CommandLine.arguments
func option(_ name: String, fallback: String) -> String {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return fallback }
    return arguments[index + 1]
}
let locale = option("--locale", fallback: "it-IT")
let localOnly = !arguments.contains("--allow-network")
let maxSeconds = min(120.0, max(1.0, Double(option("--max-seconds", fallback: "45")) ?? 45))

final class Voice {
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
    var engine: AVAudioEngine?
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var timer: Timer?
    var deadline: DispatchWorkItem?
    var recording = false
    var waiting = false
    var ready = false
    var generation = 0
    var startedAt = Date()
    var foreground: pid_t?
    var tapInstalled = false
    var releaseTimer: Timer?

    func awaitKeyRelease() {
        releaseTimer?.invalidate()
        if !CGEventSource.keyState(.combinedSessionState, key: 49) {
            emit(["type": "released"])
            return
        }
        releaseTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { timer in
            if !CGEventSource.keyState(.combinedSessionState, key: 49) {
                timer.invalidate()
                self.releaseTimer = nil
                emit(["type": "released"])
            }
        }
    }

    func fail(_ message: String, fatal: Bool = false) {
        cancel(announce: false)
        emit(["type": "error", "message": message, "fatal": fatal])
        if fatal { exit(1) }
    }

    func initialize() {
        AVCaptureDevice.requestAccess(for: .audio) { allowed in
            DispatchQueue.main.async {
                guard allowed else {
                    self.fail("Microfono non autorizzato. Abilitalo in Impostazioni di Sistema → Privacy e sicurezza → Microfono per JARVIS Voice o il terminale.", fatal: true)
                    return
                }
                SFSpeechRecognizer.requestAuthorization { status in
                    DispatchQueue.main.async {
                        guard status == .authorized else {
                            self.fail("Riconoscimento vocale non autorizzato. Controlla Privacy e sicurezza → Riconoscimento vocale.", fatal: true)
                            return
                        }
                        guard let recognizer = self.recognizer, recognizer.isAvailable else {
                            self.fail("Riconoscimento vocale non disponibile per \(locale). Controlla la lingua di Dettatura nelle impostazioni macOS.", fatal: true)
                            return
                        }
                        guard !localOnly || recognizer.supportsOnDeviceRecognition else {
                            self.fail("Trascrizione locale non disponibile per \(locale). Installa le risorse di Dettatura macOS oppure abilita esplicitamente voice.stt.localOnly: false per usare il servizio Apple.", fatal: true)
                            return
                        }
                        self.ready = true
                        emit(["type": "ready", "locale": locale, "localOnly": localOnly])
                    }
                }
            }
        }
    }

    func start() {
        guard ready, !recording, !waiting else { return }
        // A pasted space or a press already released must never open the microphone.
        guard CGEventSource.keyState(.combinedSessionState, key: 49) else {
            emit(["type": "released"])
            emit(["type": "cancelled", "message": "Tieni premuto Spazio mentre parli (solo tastiera locale)."])
            return
        }
        guard let recognizer = recognizer, recognizer.isAvailable else {
            fail("Riconoscimento vocale temporaneamente non disponibile.")
            return
        }
        generation += 1
        let current = generation
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = localOnly
        request.shouldReportPartialResults = false
        request.taskHint = .dictation
        request.contextualStrings = ["Codex", "Claude", "JARVIS", "TypeScript", "Git", "commit", "pull request"]
        self.request = request
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("Nessun microfono disponibile. Controlla il dispositivo di ingresso macOS.")
            return
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        tapInstalled = true
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                guard current == self.generation else { return }
                // Never dispatch an early endpoint while Space is still held.
                if let result = result, result.isFinal {
                    guard self.waiting else {
                        self.fail("Riconoscimento terminato prima del rilascio: richiesta non inviata. Riprova con una frase più breve.")
                        return
                    }
                    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                    let scores = result.bestTranscription.segments.map { Double($0.confidence) }.filter { $0 > 0 }
                    let confidence = scores.isEmpty ? nil : scores.reduce(0, +) / Double(scores.count)
                    self.cancel(announce: false)
                    guard !text.isEmpty else { emit(["type": "cancelled", "message": "Nessuna voce riconosciuta."]); return }
                    var event: [String: Any] = ["type": "transcript", "text": text, "language": locale]
                    if let confidence = confidence { event["confidence"] = confidence }
                    emit(event)
                } else if let error = error {
                    self.fail("Trascrizione non riuscita: \(error.localizedDescription)")
                }
            }
        }
        do {
            engine.prepare()
            try engine.start()
            recording = true
            startedAt = Date()
            foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
            emit(["type": "listening"])
            timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
                if self.foreground != NSWorkspace.shared.frontmostApplication?.processIdentifier {
                    self.cancel()
                } else if Date().timeIntervalSince(self.startedAt) >= maxSeconds {
                    self.fail("Limite di \(Int(maxSeconds)) secondi raggiunto: registrazione annullata. Rilascia Spazio e riprova.")
                } else if !CGEventSource.keyState(.combinedSessionState, key: 49) {
                    self.release()
                }
            }
        } catch { fail("Impossibile avviare il microfono: \(error.localizedDescription)") }
    }

    func stopMicrophone() {
        timer?.invalidate()
        timer = nil
        if let engine = engine {
            engine.stop()
            if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
        }
        engine = nil
        tapInstalled = false
        recording = false
    }

    func release() {
        guard recording else { return }
        let duration = Date().timeIntervalSince(startedAt)
        stopMicrophone()
        emit(["type": "released"])
        if duration < 0.25 { cancel(); return }
        waiting = true
        emit(["type": "transcribing"])
        request?.endAudio()
        let current = generation
        let timeout = DispatchWorkItem {
            if current == self.generation { self.fail("Timeout di trascrizione: richiesta non inviata.") }
        }
        deadline = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)
    }

    func cancel(announce: Bool = true) {
        generation += 1
        deadline?.cancel()
        deadline = nil
        stopMicrophone()
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        waiting = false
        awaitKeyRelease()
        if announce { emit(["type": "cancelled", "message": "Registrazione annullata; microfono spento."]) }
    }
}

if arguments.contains("--check") {
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
    emit(["type": "diagnostics", "locale": locale,
          "microphonePermission": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
          "speechPermission": SFSpeechRecognizer.authorizationStatus().rawValue,
          "onDeviceSupported": recognizer?.supportsOnDeviceRecognition ?? false])
    exit(0)
}

let voice = Voice()
var signalSources: [DispatchSourceSignal] = []
for number in [SIGINT, SIGTERM] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { voice.cancel(announce: false); exit(0) }
    source.resume()
    signalSources.append(source)
}
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        DispatchQueue.main.async {
            switch line {
            case "start": voice.start()
            case "cancel": voice.cancel()
            case "close": voice.cancel(announce: false); exit(0)
            default: break
            }
        }
    }
    DispatchQueue.main.async { voice.cancel(announce: false); exit(0) }
}
voice.initialize()
RunLoop.main.run()
