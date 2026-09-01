// svg2png <in.svg|in.png> <out.png> <size> — rasterise with transparent background (AppKit SVG support).
// With a single PNG argument it just prints the corner pixel RGBA (verification mode).
import AppKit

let args = CommandLine.arguments
func cornerReport(_ path: String) {
  guard let img = NSImage(contentsOfFile: path),
        let tiff = img.tiffRepresentation,
        let rep = NSBitmapImageRep(data: tiff) else { fatalError("cannot read \(path)") }
  let c = rep.colorAt(x: 2, y: 2)!
  print("corner rgba:", c.redComponent, c.greenComponent, c.blueComponent, c.alphaComponent)
}
if args.count == 2 { cornerReport(args[1]); exit(0) }
guard args.count == 4, let size = Int(args[3]) else { fatalError("usage: svg2png in.svg out.png size") }
guard let svg = NSImage(contentsOfFile: args[1]) else { fatalError("cannot load \(args[1])") }
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                           colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current?.imageInterpolation = .high
svg.draw(in: NSRect(x: 0, y: 0, width: size, height: size),
         from: .zero, operation: .copy, fraction: 1.0)
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("png encode failed") }
try! png.write(to: URL(fileURLWithPath: args[2]))
let c = rep.colorAt(x: 2, y: 2)!
print("written \(args[2]) corner rgba:", c.redComponent, c.greenComponent, c.blueComponent, c.alphaComponent)
