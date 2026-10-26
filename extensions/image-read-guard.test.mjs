// Harness for image-read-guard.ts: build one real file per format in a temp dir
// and assert the guard blocks raster images while letting text/SVG/non-images
// through (fail open). Mirrors pi's magic-byte rules from dist/utils/mime.js.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL('/home/brady/.pi/agent/extensions/image-read-guard.ts').href);
const ext = mod.default;
const handlers = {};
const pi = { on: (name, fn) => { (handlers[name] ||= []).push(fn); } };
ext(pi);

const dir = mkdtempSync(join(tmpdir(), 'img-guard-'));

// --- minimal but valid magic-byte files ---
const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = Buffer.from([...pngSig, ...u32be(13), ...Buffer.from('IHDR'), 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const gif = Buffer.from('GIF89a' + '\x01\x00\x01\x00\x80\x00\x00', 'binary');
const webp = Buffer.from([...Buffer.from('RIFF'), 0x24, 0, 0, 0, ...Buffer.from('WEBP'), ...Buffer.from('VP8 ')]);
// 30-byte BMP: BM, size 0, offset 54, DIB 40, planes 1, bpp 24.
const bmp = Buffer.alloc(30);
bmp.write('BM', 0, 'ascii');
bmp.writeUInt32LE(54, 10);
bmp.writeUInt32LE(40, 14);
bmp.writeUInt16LE(1, 26);
bmp.writeUInt16LE(24, 28);

writeFileSync(join(dir, 'a.png'), png);
writeFileSync(join(dir, 'a.jpg'), jpeg);
writeFileSync(join(dir, 'a.jpeg'), jpeg);
writeFileSync(join(dir, 'a.gif'), gif);
writeFileSync(join(dir, 'a.webp'), webp);
writeFileSync(join(dir, 'a.bmp'), bmp);
writeFileSync(join(dir, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>');
writeFileSync(join(dir, 'a.txt'), 'plain text, not an image\n');
writeFileSync(join(dir, 'sneaky.png'), 'I lie about my extension\n'); // text named .png
writeFileSync(join(dir, 'noext'), png); // image with no extension
writeFileSync(join(dir, 'bmp-text.txt'), 'BM just some text that starts with BM\n');

let pass = 0;
let fail = 0;
const chk = (name, cond, info = '') => {
  if (cond) { pass++; console.log(`  PASS ${name} ${info}`); }
  else { fail++; console.log(`  FAIL ${name} ${info}`); }
};

async function callRead(path, cwd = dir) {
  const event = { type: 'tool_call', toolName: 'read', toolCallId: 'x', input: { path } };
  let result;
  for (const h of handlers.tool_call) {
    const r = await h(event, { cwd });
    if (r) result = r;
  }
  return result;
}

const blocks = async (p) => !!(await callRead(p))?.block;
const passes = async (p) => !(await callRead(p))?.block;

console.log('=== 1. raster formats are blocked (by magic bytes, not extension) ===');
chk('png blocked', await blocks('a.png'));
chk('jpg blocked', await blocks('a.jpg'));
chk('jpeg blocked', await blocks('a.jpeg'));
chk('gif blocked', await blocks('a.gif'));
chk('webp blocked', await blocks('a.webp'));
chk('bmp blocked', await blocks('a.bmp'));
chk('extensionless image blocked', await blocks('noext'));
chk('absolute path blocked', await blocks(join(dir, 'a.png')));

console.log('=== 2. SVG and text pass through ===');
chk('svg passes', await passes('a.svg'));
chk('txt passes', await passes('a.txt'));
chk('text named .png passes (sniffs content)', await passes('sneaky.png'));
chk('text starting with BM passes (BMP validation)', await passes('bmp-text.txt'));

console.log('=== 3. missing / directory paths fail open ===');
chk('missing file passes', await passes('does-not-exist.png'));
chk('directory passes', await passes('.'));

console.log('=== 4. block reason is instructive ===');
{
  const r = await callRead('a.png');
  chk('mentions mime', /image\/png/.test(r.reason), r.reason.slice(0, 60));
  chk('says do not retry', /Do not retry/.test(r.reason));
}

console.log('=== 5. unrelated tools are untouched ===');
{
  const event = { type: 'tool_call', toolName: 'bash', toolCallId: 'x', input: { command: 'cat a.png' } };
  let r;
  for (const h of handlers.tool_call) r = (await h(event, { cwd: dir })) ?? r;
  chk('bash not blocked', !r?.block);
}

console.log('=== 6. companion defense-in-depth is wired ===');
{
  // blockImages covers sources this guard cannot see (pasted images, codemode
  // image(), MCP tools). If settings.json loses it, those images reach the model.
  const settings = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8'));
  chk('settings.images.blockImages === true', settings?.images?.blockImages === true, JSON.stringify(settings?.images));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
