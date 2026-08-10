import { describe, expect, it } from 'vitest';
import { resolveNativeHeaderTitleInset } from './chatHeaderLayout';

describe('chatHeaderLayout', () => {
    it('reserves symmetric title space for the wider native header control', () => {
        expect(resolveNativeHeaderTitleInset(44, 120, 8)).toBe(128);
        expect(resolveNativeHeaderTitleInset(44, 28, 8)).toBe(52);
    });

    it('uses only the gap when neither side has a control', () => {
        expect(resolveNativeHeaderTitleInset(0, 0, 8)).toBe(8);
    });
});
