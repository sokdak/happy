import { describe, it, expect, beforeEach, vi } from 'vitest';

const disk = vi.hoisted(() => ({
    values: new Map<string, string>(),
    getString: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
}));

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString = disk.getString;
        set = disk.set;
        delete = disk.delete;
    }
}));

import { rewriteLoopbackHost, setServerUrl, getServerUrl } from './serverConfig';

describe('rewriteLoopbackHost', () => {
    beforeEach(() => {
        disk.values.clear();
        disk.getString.mockImplementation((key: string) => disk.values.get(key));
        disk.set.mockImplementation((key: string, value: string) => disk.values.set(key, value));
        disk.delete.mockImplementation((key: string) => disk.values.delete(key));
        setServerUrl('https://api.happy.example.com');
    });

    it('rewrites loopback hosts to the configured server URL', () => {
        expect(rewriteLoopbackHost('http://localhost:3005/v1/attachments/file.enc'))
            .toBe('https://api.happy.example.com/v1/attachments/file.enc');
        expect(rewriteLoopbackHost('http://127.0.0.1:3005/v1/attachments/file.enc'))
            .toBe('https://api.happy.example.com/v1/attachments/file.enc');
    });

    it('upgrades protocol when host matches configured server URL but protocol differs', () => {
        expect(rewriteLoopbackHost('http://api.happy.example.com/v1/sessions/1/attachments/file.enc'))
            .toBe('https://api.happy.example.com/v1/sessions/1/attachments/file.enc');
    });

    it('leaves external URLs untouched', () => {
        expect(rewriteLoopbackHost('https://s3.amazonaws.com/bucket/file.enc'))
            .toBe('https://s3.amazonaws.com/bucket/file.enc');
    });
});
