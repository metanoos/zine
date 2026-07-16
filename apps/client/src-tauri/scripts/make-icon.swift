// Renders the app icon source: the 👁️‍🗨️ brand glyph on a grey rounded box.
//
// The background is a neutral grey box with rounded corners, everything
// outside the box transparent. Corner radius (~22.2% of the side) is the
// standard app-icon radius: large enough to read as "rounded" on Windows,
// close enough to the macOS squircle mask that it doesn't double-round.
// The glyph sits centered with optical margin so it survives the mask.

import AppKit

let size = 1024
let glyph = "👁️\u{200D}🗨️" // 👁️‍🗨️ (eye + VS16 + ZWJ + speech bubble) — matches App.tsx EYE_SPEECH

// Very light grey, just off-white so it's distinguishable from a pure-white
// backdrop but stays bright and airy.
let boxColor = NSColor(calibratedWhite: 0.96, alpha: 1)
// 22.2% radius ≈ the iOS/macOS "continuous" app-icon corner.
let radius = CGFloat(size) * 0.222
let outPath = "icons/icon.png"

let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

NSGraphicsContext.current?.imageInterpolation = .high

// Grey rounded box, full-bleed; transparent outside the path.
let box = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size),
                       xRadius: radius, yRadius: radius)
boxColor.setFill()
box.fill()

// The glyph, drawn large and centered. 0.72 leaves optical margin so the
// bubble doesn't kiss the box edge after the platform mask.
let font = NSFont.systemFont(ofSize: CGFloat(size) * 0.72)
let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: NSColor.black, // ignored for color emoji, but required
]
let str = NSAttributedString(string: glyph, attributes: attrs)
let textSize = str.size()
let origin = NSPoint(
    x: (CGFloat(size) - textSize.width) / 2,
    y: (CGFloat(size) - textSize.height) / 2
)
str.draw(at: origin)

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write(Data("failed to build PNG\n".utf8))
    exit(1)
}

try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath) (\(png.count) bytes)")
