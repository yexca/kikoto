import AVFoundation
import AVKit
import CoreMedia
import CoreVideo
import UIKit

/// One timed lyric line, already bounded by the plugin.
struct KikotoLyricLine {
    let timeMs: Double
    let text: String
}

/// Colors for the Picture-in-Picture frame, taken from the app theme.
struct KikotoLyricsAppearance {
    let background: UIColor
    let foreground: UIColor
    let accent: UIColor

    /// The dark look used when the web app sends no theme.
    static let fallback = KikotoLyricsAppearance(
        background: UIColor(white: 0.07, alpha: 1),
        foreground: .white,
        accent: UIColor(white: 0.28, alpha: 1)
    )
}

/// Renders the current lyric line into a Picture-in-Picture window.
///
/// WKWebView exposes no usable web Picture-in-Picture, so the line is drawn
/// natively into an AVSampleBufferDisplayLayer. The presenter advances the line
/// on its own clock from the last playback state it received, which keeps it
/// in sync while the web view is in the background. It does not touch the
/// audio session, Now Playing, or remote commands; the web player owns those.
///
/// Accessed only on the main queue.
final class KikotoLyricsPictureInPicture: NSObject {
    var onClosed: (() -> Void)?
    var onPlaybackControl: ((Bool) -> Void)?
    /// A skip-button seek, as the new absolute position in milliseconds.
    var onSeek: ((Double) -> Void)?

    /// A wide strip keeps the window short so it covers less of the screen.
    private static let frameSize = CGSize(width: 960, height: 240)
    /// How far the background gradient moves toward the accent color.
    private static let accentBlend: CGFloat = 0.22
    private static let tickInterval: TimeInterval = 0.2
    private static let startDelay: TimeInterval = 0.5
    private static let startTimeout: TimeInterval = 3
    /// Picture-in-Picture keeps a still frame most reliably when it is refreshed.
    private static let refreshInterval: CFTimeInterval = 1

    private var title = ""
    private var appearance = KikotoLyricsAppearance.fallback
    private var lines: [KikotoLyricLine] = []
    private var anchorPositionMs: Double = 0
    private var anchorTime = CACurrentMediaTime()
    private var playing = false
    private var playbackRate: Double = 1
    /// The track length; with none known the window stays live, with no progress bar or skip buttons.
    private var durationMs: Double = 0

    private var hostView: UIView?
    private var displayLayer: AVSampleBufferDisplayLayer?
    private var controller: AVPictureInPictureController?
    private var possibleObservation: NSKeyValueObservation?
    private var startDeadline: DispatchWorkItem?
    private var timer: Timer?
    private var renderedKey: String?
    private var renderedAt: CFTimeInterval = 0

    static var isSupported: Bool {
        AVPictureInPictureController.isPictureInPictureSupported()
    }

    func show(
        title: String,
        lines: [KikotoLyricLine],
        appearance: KikotoLyricsAppearance,
        positionMs: Double,
        playing: Bool,
        playbackRate: Double,
        durationMs: Double,
        in container: UIView
    ) {
        self.title = title
        self.appearance = appearance
        self.lines = lines
        applyDuration(durationMs)
        applyPlayback(positionMs: positionMs, playing: playing, playbackRate: playbackRate)
        renderedKey = nil
        if controller == nil {
            start(in: container)
        } else {
            controller?.invalidatePlaybackState()
            renderIfNeeded()
        }
    }

    func update(positionMs: Double, playing: Bool, playbackRate: Double, durationMs: Double) {
        applyDuration(durationMs)
        applyPlayback(positionMs: positionMs, playing: playing, playbackRate: playbackRate)
        controller?.invalidatePlaybackState()
        renderIfNeeded()
    }

    /// Closes Picture-in-Picture for the web app without reporting it back.
    func hide() {
        if let controller, controller.isPictureInPictureActive {
            controller.stopPictureInPicture()
        }
        teardown()
    }

    private func applyPlayback(positionMs: Double, playing: Bool, playbackRate: Double) {
        anchorPositionMs = max(0, positionMs)
        anchorTime = CACurrentMediaTime()
        self.playing = playing
        self.playbackRate = playbackRate > 0 ? playbackRate : 1
        syncTimebase()
    }

    private func applyDuration(_ durationMs: Double) {
        self.durationMs = durationMs.isFinite && durationMs > 0 ? durationMs : 0
        // Skip buttons appear only for a seekable, finite range.
        controller?.requiresLinearPlayback = self.durationMs <= 0
    }

    /// The window's progress bar reads the layer timebase, so it follows the
    /// playback position rather than the host clock. A jump in position drops
    /// queued frames; the next render presents the line for the new position.
    private func syncTimebase() {
        guard let displayLayer, let timebase = displayLayer.controlTimebase else { return }
        CMTimebaseSetTime(timebase, time: CMTime(seconds: currentPositionMs() / 1000, preferredTimescale: 1000))
        CMTimebaseSetRate(timebase, rate: playing ? playbackRate : 0)
        if #available(iOS 17.0, *) {
            displayLayer.sampleBufferRenderer.flush()
        } else {
            displayLayer.flush()
        }
        renderedKey = nil
    }

    private func start(in container: UIView) {
        // The controller initializer returns nil where Picture-in-Picture is unsupported.
        guard Self.isSupported else {
            onClosed?()
            return
        }
        // The layer must be in the window hierarchy for Picture-in-Picture to
        // start. A small host behind the opaque web view keeps it there unseen.
        let host = UIView(frame: CGRect(x: 0, y: 0, width: 192, height: 48))
        host.isUserInteractionEnabled = false
        let layer = AVSampleBufferDisplayLayer()
        layer.frame = host.bounds
        layer.videoGravity = .resizeAspect
        var timebase: CMTimebase?
        if CMTimebaseCreateWithSourceClock(
            allocator: kCFAllocatorDefault,
            sourceClock: CMClockGetHostTimeClock(),
            timebaseOut: &timebase
        ) == noErr, let timebase {
            layer.controlTimebase = timebase
        }
        host.layer.addSublayer(layer)
        container.insertSubview(host, at: 0)
        hostView = host
        displayLayer = layer
        syncTimebase()

        let source = AVPictureInPictureController.ContentSource(sampleBufferDisplayLayer: layer, playbackDelegate: self)
        let pictureInPicture = AVPictureInPictureController(contentSource: source)
        pictureInPicture.delegate = self
        controller = pictureInPicture
        applyDuration(durationMs)
        renderIfNeeded()

        let tick = Timer(timeInterval: Self.tickInterval, repeats: true) { [weak self] _ in
            self?.renderIfNeeded()
        }
        RunLoop.main.add(tick, forMode: .common)
        timer = tick

        // A start requested in the same turn as the first frame is silently
        // ignored, so wait for the layer to present it before starting.
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.startDelay) { [weak self] in
            self?.startWhenPossible(pictureInPicture)
        }
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, let controller = self.controller, !controller.isPictureInPictureActive else { return }
            self.finish()
        }
        startDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.startTimeout, execute: deadline)
    }

    private func startWhenPossible(_ pictureInPicture: AVPictureInPictureController) {
        guard controller === pictureInPicture, !pictureInPicture.isPictureInPictureActive else { return }
        if pictureInPicture.isPictureInPicturePossible {
            pictureInPicture.startPictureInPicture()
            return
        }
        possibleObservation = pictureInPicture.observe(\.isPictureInPicturePossible, options: [.new]) { [weak self] controller, _ in
            guard controller.isPictureInPicturePossible else { return }
            DispatchQueue.main.async {
                guard let self, self.controller === controller, !controller.isPictureInPictureActive else { return }
                self.possibleObservation = nil
                controller.startPictureInPicture()
            }
        }
    }

    /// Ends Picture-in-Picture that the user or the system closed.
    private func finish() {
        let notify = controller != nil
        teardown()
        if notify { onClosed?() }
    }

    private func teardown() {
        timer?.invalidate()
        timer = nil
        possibleObservation = nil
        startDeadline?.cancel()
        startDeadline = nil
        controller?.delegate = nil
        controller = nil
        if let displayLayer {
            if #available(iOS 17.0, *) {
                displayLayer.sampleBufferRenderer.flush(removingDisplayedImage: true, completionHandler: nil)
            } else {
                displayLayer.flushAndRemoveImage()
            }
        }
        displayLayer?.removeFromSuperlayer()
        displayLayer = nil
        hostView?.removeFromSuperview()
        hostView = nil
        renderedKey = nil
    }

    private func currentPositionMs() -> Double {
        guard playing else { return anchorPositionMs }
        return anchorPositionMs + (CACurrentMediaTime() - anchorTime) * 1000 * playbackRate
    }

    private func activeIndex(at positionMs: Double) -> Int {
        var low = 0
        var high = lines.count - 1
        var found = -1
        while low <= high {
            let middle = (low + high) / 2
            if lines[middle].timeMs <= positionMs {
                found = middle
                low = middle + 1
            } else {
                high = middle - 1
            }
        }
        return found
    }

    private func renderIfNeeded() {
        guard let displayLayer else { return }
        var needsFlush: Bool
        if #available(iOS 17.0, *) {
            needsFlush = displayLayer.sampleBufferRenderer.status == .failed
                || displayLayer.sampleBufferRenderer.requiresFlushToResumeDecoding
        } else {
            needsFlush = displayLayer.status == .failed || displayLayer.requiresFlushToResumeDecoding
        }
        if needsFlush {
            if #available(iOS 17.0, *) {
                displayLayer.sampleBufferRenderer.flush()
            } else {
                displayLayer.flush()
            }
            renderedKey = nil
        }

        let index = activeIndex(at: currentPositionMs())
        let current = index >= 0 ? lines[index].text : ""
        let next = lines.dropFirst(index + 1).first { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }?.text ?? ""
        let primary = current.isEmpty ? title : current
        let secondary = current.isEmpty ? "" : next
        let key = "\(primary)\u{1F}\(secondary)"
        let now = CACurrentMediaTime()
        guard key != renderedKey || now - renderedAt >= Self.refreshInterval,
              let sample = Self.sampleBuffer(
                  primary: primary,
                  secondary: secondary,
                  appearance: appearance,
                  presentationTime: displayLayer.controlTimebase.map { CMTimebaseGetTime($0) }
                      ?? CMClockGetTime(CMClockGetHostTimeClock())
              ) else { return }
        renderedKey = key
        renderedAt = now
        if #available(iOS 17.0, *) {
            displayLayer.sampleBufferRenderer.enqueue(sample)
        } else {
            displayLayer.enqueue(sample)
        }
    }

    private static func sampleBuffer(
        primary: String,
        secondary: String,
        appearance: KikotoLyricsAppearance,
        presentationTime: CMTime
    ) -> CMSampleBuffer? {
        let width = Int(frameSize.width)
        let height = Int(frameSize.height)
        let attributes: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
        ]
        var pixelBuffer: CVPixelBuffer?
        guard
            CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &pixelBuffer) == kCVReturnSuccess,
            let pixelBuffer
        else { return nil }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(pixelBuffer),
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { return nil }

        drawBackground(in: context, appearance: appearance)
        // UIKit text drawing expects a top-left origin.
        context.translateBy(x: 0, y: frameSize.height)
        context.scaleBy(x: 1, y: -1)
        UIGraphicsPushContext(context)
        drawLine(primary, size: 64, minimumSize: 32, weight: .semibold, color: appearance.foreground, centerY: frameSize.height * 0.4)
        drawLine(
            secondary,
            size: 38,
            minimumSize: 24,
            weight: .regular,
            color: appearance.foreground.withAlphaComponent(0.62),
            centerY: frameSize.height * 0.78
        )
        UIGraphicsPopContext()

        var format: CMVideoFormatDescription?
        guard
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixelBuffer, formatDescriptionOut: &format) == noErr,
            let format
        else { return nil }
        var timing = CMSampleTimingInfo(
            duration: .invalid,
            presentationTimeStamp: presentationTime,
            decodeTimeStamp: .invalid
        )
        var sample: CMSampleBuffer?
        guard
            CMSampleBufferCreateReadyWithImageBuffer(
                allocator: nil,
                imageBuffer: pixelBuffer,
                formatDescription: format,
                sampleTiming: &timing,
                sampleBufferOut: &sample
            ) == noErr,
            let sample
        else { return nil }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(
                dictionary,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
        }
        return sample
    }

    /// A diagonal wash from the theme background toward its accent color.
    private static func drawBackground(in context: CGContext, appearance: KikotoLyricsAppearance) {
        let start = appearance.background
        let end = blend(appearance.background, appearance.accent, amount: accentBlend)
        guard let gradient = CGGradient(
            colorsSpace: context.colorSpace,
            colors: [start.cgColor, end.cgColor] as CFArray,
            locations: [0, 1]
        ) else {
            context.setFillColor(start.cgColor)
            context.fill(CGRect(origin: .zero, size: frameSize))
            return
        }
        // The context origin is bottom-left here, so this runs top-left to bottom-right.
        context.drawLinearGradient(
            gradient,
            start: CGPoint(x: 0, y: frameSize.height),
            end: CGPoint(x: frameSize.width, y: 0),
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
    }

    private static func blend(_ base: UIColor, _ tint: UIColor, amount: CGFloat) -> UIColor {
        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        guard base.getRed(&r1, green: &g1, blue: &b1, alpha: &a1),
              tint.getRed(&r2, green: &g2, blue: &b2, alpha: &a2) else { return base }
        return UIColor(
            red: r1 + (r2 - r1) * amount,
            green: g1 + (g2 - g1) * amount,
            blue: b1 + (b2 - b1) * amount,
            alpha: 1
        )
    }

    private static func drawLine(
        _ text: String,
        size: CGFloat,
        minimumSize: CGFloat,
        weight: UIFont.Weight,
        color: UIColor,
        centerY: CGFloat
    ) {
        guard !text.isEmpty else { return }
        let maxWidth = frameSize.width - 72
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byTruncatingTail
        var fontSize = size
        var attributes: [NSAttributedString.Key: Any] = [:]
        var measured = CGSize.zero
        repeat {
            attributes = [
                .font: UIFont.systemFont(ofSize: fontSize, weight: weight),
                .foregroundColor: color,
                .paragraphStyle: paragraph,
            ]
            measured = (text as NSString).size(withAttributes: attributes)
            fontSize -= 2
        } while measured.width > maxWidth && fontSize >= minimumSize
        let rect = CGRect(x: 36, y: centerY - measured.height / 2, width: maxWidth, height: measured.height)
        (text as NSString).draw(with: rect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes, context: nil)
    }
}

extension KikotoLyricsPictureInPicture: AVPictureInPictureControllerDelegate {
    func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        guard pictureInPictureController === controller else { return }
        finish()
    }

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        failedToStartPictureInPictureWithError error: Error
    ) {
        guard pictureInPictureController === controller else { return }
        finish()
    }

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(true)
    }
}

extension KikotoLyricsPictureInPicture: AVPictureInPictureSampleBufferPlaybackDelegate {
    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {
        // Reflect the request at once; the web player confirms with an update.
        applyPlayback(positionMs: currentPositionMs(), playing: playing, playbackRate: playbackRate)
        pictureInPictureController.invalidatePlaybackState()
        onPlaybackControl?(playing)
    }

    func pictureInPictureControllerTimeRangeForPlayback(_ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange {
        // A known length shows progress and skip buttons; otherwise the range is live.
        guard durationMs > 0 else { return CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity) }
        return CMTimeRange(start: .zero, duration: CMTime(seconds: durationMs / 1000, preferredTimescale: 1000))
    }

    func pictureInPictureControllerIsPlaybackPaused(_ pictureInPictureController: AVPictureInPictureController) -> Bool {
        !playing
    }

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        didTransitionToRenderSize newRenderSize: CMVideoDimensions
    ) {}

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        skipByInterval skipInterval: CMTime,
        completion completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        let interval = CMTimeGetSeconds(skipInterval)
        guard durationMs > 0, interval.isFinite else { return }
        // Move the lines at once; the web player seeks and confirms with an update.
        let position = min(max(0, currentPositionMs() + interval * 1000), durationMs)
        applyPlayback(positionMs: position, playing: playing, playbackRate: playbackRate)
        pictureInPictureController.invalidatePlaybackState()
        renderIfNeeded()
        onSeek?(position)
    }
}
