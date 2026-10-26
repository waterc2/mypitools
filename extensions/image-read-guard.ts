// PURPOSE: stop the `read` tool from loading raster images (jpeg/png/gif/webp/bmp)
//          into the transcript. pi's read sniffs magic bytes and attaches the file
//          as a base64 image block; that block then lives in the session jsonl and,
//          for a non-vision model, is discarded from the request anyway. Over
//          2026-10-09..12 that was 25/26 image reads (~9.6MB) of pure waste.
//          SVG is intentionally NOT blocked: pi does not sniff it as an image
//          (it is XML text), so `read` returns its text and this guard passes it.
// COMPANION: settings.json `images.blockImages: true` is enabled as defense in
//          depth. This guard stops the `read` tool, so no base64 ever enters the
//          session log or context; blockImages additionally strips image blocks
//          from every provider request (pi applies it in convertToLlm), covering
//          sources this guard cannot see: pasted images, codemode image(), and
//          MCP tools that return images. The two are complementary, not redundant.
// INPUT:   `tool_call` events with toolName === "read". event.input.path is
//          resolved against ctx.cwd the same way pi's resolveReadPathAsync does
//          (~ / @ / unicode-space normalization + macOS name variants), then the
//          first 4100 bytes are matched against pi's own magic-byte rules.
// MUTATION: none. Returns { block: true, reason } for raster images; every other
//          call (text, SVG, missing file, directory) passes through untouched so
//          `read` can either succeed or raise its own ENOENT/EISDIR error.
// DETERMINISM: pure magic-byte matching; no randomness, no clock, no config, no
//          toggle. Sniff failures fail open.
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

function startsWithAscii(buf: Buffer, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (buf[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function u16le(buf: Buffer, o: number): number {
  return (buf[o] ?? 0) + ((buf[o + 1] ?? 0) << 8);
}

function u32be(buf: Buffer, o: number): number {
  return (buf[o] ?? 0) * 0x1000000 + ((buf[o + 1] ?? 0) << 16) + ((buf[o + 2] ?? 0) << 8) + (buf[o + 3] ?? 0);
}

function u32le(buf: Buffer, o: number): number {
  return (buf[o] ?? 0) + ((buf[o + 1] ?? 0) << 8) + ((buf[o + 2] ?? 0) << 16) + (buf[o + 3] ?? 0) * 0x1000000;
}

// A PNG always begins with the 8-byte signature followed by the IHDR chunk.
function isPng(buf: Buffer): boolean {
  return buf.length >= 16 && u32be(buf, PNG_SIGNATURE.length) === 13 && startsWithAscii(buf, 12, 'IHDR');
}

// "BM" is too weak on its own (it can start plain text), so validate the BMP
// file header + DIB header the way pi's mime.js does.
function isBmp(buf: Buffer): boolean {
  if (buf.length < 26) return false;
  const declaredFileSize = u32le(buf, 2);
  const pixelDataOffset = u32le(buf, 10);
  const dibHeaderSize = u32le(buf, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = u16le(buf, 22);
    bitsPerPixel = u16le(buf, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buf.length < 30) return false;
    colorPlanes = u16le(buf, 26);
    bitsPerPixel = u16le(buf, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

/** Mime type of the raster formats pi's `read` would attach, or null. SVG returns null. */
export function detectRasterImageMime(buf: Buffer): string | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return buf[3] === 0xf7 ? null : 'image/jpeg';
  if (startsWith(buf, PNG_SIGNATURE)) return isPng(buf) ? 'image/png' : null;
  if (startsWithAscii(buf, 0, 'GIF87a') || startsWithAscii(buf, 0, 'GIF89a')) return 'image/gif';
  if (startsWithAscii(buf, 0, 'RIFF') && startsWithAscii(buf, 8, 'WEBP')) return 'image/webp';
  if (startsWithAscii(buf, 0, 'BM') && isBmp(buf)) return 'image/bmp';
  return null;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// Mirror pi's resolvePath + the macOS variants resolveReadPathAsync tries, so the
// guard sniffs the same file `read` would open.
function candidatePaths(rawPath: string, cwd: string): string[] {
  let p = rawPath.replace(UNICODE_SPACES, ' ');
  if (p.startsWith('@')) p = p.slice(1);
  if (p === '~') p = homedir();
  else if (p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\'))) p = join(homedir(), p.slice(2));
  const base = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const out = [base];
  const ampm = base.replace(/ (AM|PM)\./gi, '\u202F$1.');
  if (ampm !== base) out.push(ampm);
  const nfd = base.normalize('NFD');
  if (nfd !== base) out.push(nfd);
  const curly = base.replace(/'/g, '\u2019');
  if (curly !== base) out.push(curly, curly.normalize('NFD'));
  return out;
}

// First readable candidate decides, matching resolveReadPathAsync's "first that
// exists wins" rule. Unreadable candidates fall through; no candidate readable
// means fail open and let `read` produce its own error.
async function sniffImageMime(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    let handle;
    try {
      handle = await open(candidate, 'r');
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
      return detectRasterImageMime(buf.subarray(0, bytesRead));
    } catch {
      // not readable: try the next name variant
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return null;
}

function blockedReason(mime: string, rawPath: string): string {
  return (
    `Image reads are disabled (${mime}): "${rawPath}" is a raster image and the read tool will not ` +
    `load it. Inspect it with bash if needed (file/identify/stat), or read the text that references ` +
    `it (SVG, source, manifest). Do not retry read on this path.`
  );
}

export default function imageReadGuard(pi: any) {
  pi.on('tool_call', async (event: any, ctx: any) => {
    if (event?.toolName !== 'read') return undefined;
    const rawPath = event?.input?.path;
    if (typeof rawPath !== 'string' || rawPath.length === 0) return undefined;
    try {
      const cwd = ctx?.cwd ?? process.cwd();
      const mime = await sniffImageMime(candidatePaths(rawPath, cwd));
      if (mime) return { block: true, reason: blockedReason(mime, rawPath) };
      return undefined;
    } catch {
      // A throwing tool_call handler blocks the call as a fail-safe; a failed
      // sniff must not. Pass through so `read` reports the real problem.
      return undefined;
    }
  });
}
