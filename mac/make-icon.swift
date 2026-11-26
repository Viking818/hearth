// Draws Hearth's app icon from public/logo.svg: the logo on the standard macOS icon grid (824 of 1024 px,
// with a soft shadow), at every size an .iconset needs. Usage: swift make-icon.swift logo.svg out.iconset
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let logo = NSImage(contentsOfFile: args[1]) else {
  FileHandle.standardError.write("usage: make-icon.swift logo.svg out.iconset\n".data(using: .utf8)!)
  exit(1)
}
let out = URL(fileURLWithPath: args[2])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: px, height: px)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(px) / 1024
  let rect = NSRect(x: 100 * s, y: 100 * s + 8 * s, width: 824 * s, height: 824 * s)
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
  shadow.shadowBlurRadius = 18 * s
  shadow.shadowOffset = NSSize(width: 0, height: -8 * s)
  shadow.set()
  logo.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128), ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
  try! render(px).write(to: out.appendingPathComponent("icon_\(name).png"))
}
