// neon-vision — tiny CLI over Apple's Vision framework used by Neon Video Studio's AI features.
//   neon-vision faces   <framesDir>                      → JSON: [{file, width, height, faces:[{x,y,w,h}]}] (normalised, top-left origin)
//   neon-vision segment <inDir> <outDir> [fast|balanced|accurate] → RGBA PNGs with the person mask as alpha
// Build: swiftc -O -o neon-vision neon-vision.swift -framework Vision -framework CoreImage -framework AppKit
import Foundation
import Vision
import CoreImage
import AppKit

struct Box: Codable { let x: Double; let y: Double; let w: Double; let h: Double }
struct FrameFaces: Codable { let file: String; let width: Int; let height: Int; let faces: [Box] }

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

func listImages(_ dir: String) -> [URL] {
  let url = URL(fileURLWithPath: dir)
  guard let items = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil) else { fail("cannot read \(dir)") }
  return items.filter { ["png", "jpg", "jpeg"].contains($0.pathExtension.lowercased()) }.sorted { $0.lastPathComponent < $1.lastPathComponent }
}

func loadCGImage(_ url: URL) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func faces(_ dir: String) {
  var out: [FrameFaces] = []
  for url in listImages(dir) {
    guard let cg = loadCGImage(url) else { continue }
    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([request])
    let boxes: [Box] = (request.results ?? []).map { obs in
      let b = obs.boundingBox // normalised, origin bottom-left
      return Box(x: b.origin.x, y: 1 - b.origin.y - b.size.height, w: b.size.width, h: b.size.height)
    }
    out.append(FrameFaces(file: url.lastPathComponent, width: cg.width, height: cg.height, faces: boxes))
  }
  let enc = JSONEncoder()
  let data = try! enc.encode(out)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func segment(_ inDir: String, _ outDir: String, _ quality: String) {
  let ctx = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!])
  try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
  let request = VNGeneratePersonSegmentationRequest()
  switch quality {
  case "fast": request.qualityLevel = .fast
  case "accurate": request.qualityLevel = .accurate
  default: request.qualityLevel = .balanced
  }
  request.outputPixelFormat = kCVPixelFormatType_OneComponent8
  let files = listImages(inDir)
  var done = 0
  for url in files {
    guard let cg = loadCGImage(url) else { continue }
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([request])
    let source = CIImage(cgImage: cg)
    var result = source
    if let mask = request.results?.first?.pixelBuffer {
      var maskImage = CIImage(cvPixelBuffer: mask)
      let sx = source.extent.width / maskImage.extent.width
      let sy = source.extent.height / maskImage.extent.height
      maskImage = maskImage.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
      let blend = CIFilter(name: "CIBlendWithMask")!
      blend.setValue(source, forKey: kCIInputImageKey)
      blend.setValue(CIImage(color: .clear).cropped(to: source.extent), forKey: kCIInputBackgroundImageKey)
      blend.setValue(maskImage, forKey: kCIInputMaskImageKey)
      result = blend.outputImage ?? source
    } else {
      result = CIImage(color: .clear).cropped(to: source.extent)
    }
    let outURL = URL(fileURLWithPath: outDir).appendingPathComponent(url.deletingPathExtension().lastPathComponent + ".png")
    if let png = ctx.pngRepresentation(of: result, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!) {
      try? png.write(to: outURL)
    }
    done += 1
    if done % 10 == 0 || done == files.count {
      FileHandle.standardError.write("progress \(done)/\(files.count)\n".data(using: .utf8)!)
    }
  }
  print("{\"frames\":\(done)}")
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: neon-vision faces <dir> | segment <inDir> <outDir> [fast|balanced|accurate]") }
switch args[1] {
case "faces": faces(args[2])
case "segment":
  guard args.count >= 4 else { fail("segment needs <inDir> <outDir>") }
  segment(args[2], args[3], args.count >= 5 ? args[4] : "balanced")
default: fail("unknown command \(args[1])")
}
