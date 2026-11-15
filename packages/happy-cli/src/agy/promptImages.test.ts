import { describe, expect, it } from 'vitest';
import { agyPromptImages } from './promptImages';

describe('Antigravity prompt images', () => {
  it('uses magic bytes instead of the claimed mobile MIME type', () => {
    const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(agyPromptImages([{ data, name: 'photo', mimeType: 'image/jpeg' }])).toEqual([
      { type: 'image', mimeType: 'image/png', data: data.toString('base64') },
    ]);
  });
  it('rejects unsupported or oversized input without silently dropping the image', () => {
    expect(() => agyPromptImages([{ data: Buffer.from('document'), name: 'a', mimeType: 'image/png' }])).toThrow('supported');
    expect(() => agyPromptImages([{ data: Buffer.alloc(10 * 1024 * 1024 + 1), name: 'a', mimeType: 'image/png' }])).toThrow('10 MiB');
  });
});
