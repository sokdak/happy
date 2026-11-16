import { describe, expect, it } from 'vitest';
import { thinkingSummary } from './thinkingSummary';

describe('thinkingSummary', () => {
    it('unwraps legacy reducer outer emphasis without corrupting separate italic spans or multiline markdown', () => {
        expect(thinkingSummary('')).toBe('');
        expect(thinkingSummary('*')).toBe('*');
        expect(thinkingSummary('**')).toBe('');
        expect(thinkingSummary('***')).toBe('*');
        expect(thinkingSummary('*Checking the manual*')).toBe('Checking the manual');
        // Reducer-wrapped `*Step 1* and *Step 2*` -> `**Step 1* and *Step 2**`
        expect(thinkingSummary('**Step 1* and *Step 2**')).toBe('*Step 1* and *Step 2*');
        // Already-unwrapped string beginning and ending with separate italic spans stays intact
        expect(thinkingSummary('*Step 1* and *Step 2*')).toBe('*Step 1* and *Step 2*');
        expect(thinkingSummary('***Plan**\n- Step 1*')).toBe('**Plan**\n- Step 1');
        // Reducer-wrapped thoughts starting with plain prose and containing inner bold, bullets, globs, or math
        expect(thinkingSummary('*Checking files:\n- **parseMarkdown.ts**\n- file.tsx*')).toBe(
            'Checking files:\n- **parseMarkdown.ts**\n- file.tsx',
        );
        expect(thinkingSummary('*Buffer size is 64 * 1024 bytes*')).toBe('Buffer size is 64 * 1024 bytes');
        expect(thinkingSummary('*Checking *user* config*')).toBe('Checking *user* config');
    });
});
