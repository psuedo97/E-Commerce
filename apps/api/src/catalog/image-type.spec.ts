import { detectImageExt } from './image-type';

const pad = (bytes: number[], total = 32) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(total - bytes.length)]);

describe('detectImageExt', () => {
  it('recognises JPEG', () => {
    expect(detectImageExt(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
  });

  it('recognises PNG', () => {
    expect(detectImageExt(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
  });

  it('recognises WebP', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
    expect(detectImageExt(webp)).toBe('webp');
  });

  it('rejects text, HTML and SVG that pretend to be images', () => {
    expect(detectImageExt(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(detectImageExt(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it('rejects empty and truncated input', () => {
    expect(detectImageExt(Buffer.alloc(0))).toBeNull();
    expect(detectImageExt(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('rejects a RIFF file that is not WebP (e.g. WAV)', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]);
    expect(detectImageExt(wav)).toBeNull();
  });
});
