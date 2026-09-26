import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic']);
const cache = new Map<string, { mtimeMs: number; text: string }>();

const VISION_SCRIPT = `
import AppKit
import Vision
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("GORSEL OKUNAMADI")
  exit(1)
}
print("Boyut: \\(cg.width)x\\(cg.height)")
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["tr-TR", "en-US"]
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg)
try handler.perform([request])
let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.isEmpty ? "OCR: (metin bulunamadi)" : "OCR:\\n" + lines.prefix(120).joined(separator: "\\n"))
`;

export function attachmentPaths(prompt: string): string[] {
  const marker = 'Ekli görseller (yerel dosya yolları):';
  const index = prompt.indexOf(marker);
  if (index < 0) return [];
  return prompt.slice(index + marker.length).split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter((value) => IMAGE_EXTENSIONS.has(path.extname(value).toLowerCase()));
}

export async function analyzeImage(imagePath: string): Promise<string> {
  try {
    const info = await stat(imagePath);
    const existing = cache.get(imagePath);
    if (existing?.mtimeMs === info.mtimeMs) return existing.text;
    const { stdout } = await execFileAsync('/usr/bin/swift', ['-e', VISION_SCRIPT, imagePath], {
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const text = stdout.trim().slice(0, 16_000);
    cache.set(imagePath, { mtimeMs: info.mtimeMs, text });
    return text;
  } catch (error) {
    return `Görsel analizi yapılamadı: ${(error as Error).message}`;
  }
}

export async function enrichPromptWithImages(prompt: string): Promise<string> {
  const paths = attachmentPaths(prompt);
  if (!paths.length) return prompt;
  const analyses = await Promise.all(paths.map(async (imagePath) =>
    `\n--- ${imagePath} ---\n${await analyzeImage(imagePath)}`,
  ));
  return `${prompt}\n\nGÖRSEL ÖN ANALİZİ (macOS Vision; işaret/yerleşim yorumunda asıl dosyayı da incele):${analyses.join('')}`;
}
