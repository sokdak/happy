import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

import { BROWSER_APP_ZOOM, getBrowserAppZoomValue } from './useTauriZoom';

describe('useTauriZoom browser defaults', () => {
    it('keeps browser web zoom fixed at 1x', () => {
        expect(BROWSER_APP_ZOOM).toBe(1);
        expect(getBrowserAppZoomValue()).toBe('1');
    });

    it('sizes zoomed body relative to 100% rather than 100vh so iOS standalone PWAs do not overflow below the status bar', () => {
        const themeCss = readFileSync(resolve(__dirname, '../theme.css'), 'utf8');
        expect(themeCss).toContain('width: calc(100% / var(--happy-app-zoom));');
        expect(themeCss).toContain('height: calc(100% / var(--happy-app-zoom));');
        expect(themeCss).not.toContain('100vh');
    });
});
