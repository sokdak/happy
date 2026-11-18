import { afterEach, describe, expect, it } from 'vitest';
import { resolveBaseUrl } from './resolveBaseUrl';

describe('resolveBaseUrl', () => {
    const originalPublicUrl = process.env.PUBLIC_URL;
    const originalPort = process.env.PORT;

    afterEach(() => {
        if (originalPublicUrl === undefined) {
            delete process.env.PUBLIC_URL;
        } else {
            process.env.PUBLIC_URL = originalPublicUrl;
        }
        if (originalPort === undefined) {
            delete process.env.PORT;
        } else {
            process.env.PORT = originalPort;
        }
    });

    it('prefers PUBLIC_URL and trims trailing slashes', () => {
        process.env.PUBLIC_URL = 'https://happy.example.com///';
        expect(resolveBaseUrl({ headers: { host: 'internal:3005' } })).toBe('https://happy.example.com');
    });

    it('extracts the first token from comma-separated x-forwarded-* headers', () => {
        delete process.env.PUBLIC_URL;
        expect(
            resolveBaseUrl({
                headers: {
                    'x-forwarded-host': 'happy.example.com, ingress.internal',
                    'x-forwarded-proto': 'https, http',
                    host: '127.0.0.1:3005',
                },
            }),
        ).toBe('https://happy.example.com');
    });

    it('upgrades http to https when x-forwarded-ssl is on', () => {
        delete process.env.PUBLIC_URL;
        expect(
            resolveBaseUrl({
                headers: {
                    host: 'happy.example.com',
                    'x-forwarded-ssl': 'on, off',
                },
            }),
        ).toBe('https://happy.example.com');
    });

    it('falls back to localhost with PORT when no host header is present', () => {
        delete process.env.PUBLIC_URL;
        process.env.PORT = '4000';
        expect(resolveBaseUrl({ headers: {} })).toBe('http://localhost:4000');
    });
});
