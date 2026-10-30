// Draws the app icon into an .iconset directory: `make-icon <out.iconset>`, then `iconutil -c icns`.
// `make-icon --mobile <dir>` writes full-bleed PNGs for phone home screens (the OS applies the mask).
// `make-icon --ios <file.png>` writes the iOS app's 1024 px icon: full-bleed and opaque, as App Store wants it.
import AppKit

func color(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

func render(_ px: Int, fullBleed: Bool = false) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    let s = CGFloat(px) / 1024
    ctx.scaleBy(x: s, y: s)

    // macOS icon grid: 824pt body centered on a 1024 canvas, with a soft drop shadow.
    // Phone icons fill the whole square; the home screen rounds the corners itself.
    let body = fullBleed ? CGRect(x: 0, y: 0, width: 1024, height: 1024) : CGRect(x: 100, y: 100, width: 824, height: 824)
    let shape = fullBleed ? CGPath(rect: body, transform: nil) : CGPath(roundedRect: body, cornerWidth: 186, cornerHeight: 186, transform: nil)
    if !fullBleed {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 28, color: color(0x000000, 0.35))
        ctx.addPath(shape)
        ctx.setFillColor(color(0x0B0F17))
        ctx.fillPath()
        ctx.restoreGState()
    }

    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()
    let bg = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [color(0x232B3B), color(0x0B0F17)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
    // Soft glow behind the ring.
    let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [color(0x3B82F6, 0.28), color(0x3B82F6, 0)] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 512), startRadius: 0, endCenter: CGPoint(x: 512, y: 512), endRadius: 380, options: [])
    ctx.restoreGState()

    // Status ring: waiting (orange), doing (blue), done (green).
    let center = CGPoint(x: 512, y: 512)
    let radius: CGFloat = 255
    ctx.setLineWidth(78)
    ctx.setLineCap(.round)
    let parts: [(UInt32, CGFloat)] = [(0xFF9F0A, 90), (0x0A84FF, 330), (0x30D158, 210)]
    for (hex, startDeg) in parts {
        let a0 = (startDeg - 44) * .pi / 180
        let a1 = (startDeg + 44) * .pi / 180
        ctx.setStrokeColor(color(hex))
        ctx.addArc(center: center, radius: radius, startAngle: a0, endAngle: a1, clockwise: false)
        ctx.strokePath()
    }
    // Center dot.
    ctx.setFillColor(color(0xFFFFFF))
    ctx.fillEllipse(in: CGRect(x: 512 - 62, y: 512 - 62, width: 124, height: 124))

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let args = CommandLine.arguments
if args.count > 2, args[1] == "--ios" {
    // Redrawn without an alpha channel: App Store rejects icons that have one, even fully opaque.
    let image = NSBitmapImageRep(data: render(1024, fullBleed: true))!.cgImage!
    let ctx = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
    exit(0)
}
if args.count > 2, args[1] == "--mobile" {
    let out = URL(fileURLWithPath: args[2], isDirectory: true)
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    for (name, size) in [("apple-touch-icon", 180), ("icon-192", 192), ("icon-512", 512)] {
        try render(size, fullBleed: true).write(to: out.appending(path: "\(name).png"))
    }
    exit(0)
}
let out = URL(fileURLWithPath: args[1], isDirectory: true)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    try render(size).write(to: out.appending(path: "icon_\(size)x\(size).png"))
    try render(size * 2).write(to: out.appending(path: "icon_\(size)x\(size)@2x.png"))
}
