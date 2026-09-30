import { describe, expect, it } from 'vitest';
import {
    getCodeAgentDefaults,
    resolveAgentDefaultConfig,
} from './agentDefaults';

describe('agent defaults', () => {
    it('uses Yolo as the code default for Claude and Codex', () => {
        // One mode, two spellings: Claude's SDK calls it `bypassPermissions`,
        // Codex calls it `yolo`. Both mean "do not prompt".
        expect(getCodeAgentDefaults('claude').permissionMode).toBe('bypassPermissions');
        expect(getCodeAgentDefaults('codex').permissionMode).toBe('yolo');
    });

    // Both spellings predate `auto`, so the shipped default no longer has a
    // version gate to clear. resolveCodeDefaultPermissionMode downgrades only
    // `auto`, and no code default is `auto` any more - it stays for the
    // picker's `auto` row and for the explicit-override paths below.
    it.each(['claude', 'codex'] as const)('keeps the Yolo default for %s on every CLI version', (flavor) => {
        const expected = flavor === 'claude' ? 'bypassPermissions' : 'yolo';
        expect(getCodeAgentDefaults(flavor, '1.2.0').permissionMode).toBe(expected);
        expect(resolveAgentDefaultConfig({}, flavor, '1.2.1-beta.1').permissionMode).toBe(expected);
        expect(resolveAgentDefaultConfig({}, flavor, '1.2.1-beta.2').permissionMode).toBe(expected);
        expect(resolveAgentDefaultConfig({}, flavor, 'not-a-version').permissionMode).toBe(expected);
        expect(resolveAgentDefaultConfig({}, flavor).permissionMode).toBe(expected);
    });

    it('does not rewrite an explicit YOLO override for an old CLI', () => {
        expect(resolveAgentDefaultConfig(
            { claude: { permissionMode: 'bypassPermissions' } },
            'claude',
            '1.2.0',
        ).permissionMode).toBe('bypassPermissions');
        expect(resolveAgentDefaultConfig(
            { codex: { permissionMode: 'yolo' } },
            'codex',
            '1.2.0',
        ).permissionMode).toBe('yolo');
    });

    it('leaves an explicit unsupported Auto override available for the send path to reject', () => {
        expect(resolveAgentDefaultConfig(
            { claude: { permissionMode: 'auto' } },
            'claude',
            '1.2.0',
        ).permissionMode).toBe('auto');
    });

    it('does not change non-code-agent defaults for an old CLI', () => {
        expect(resolveAgentDefaultConfig({}, 'gemini', '1.0.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, 'openclaw', '1.0.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, 'agy', '1.0.0').permissionMode).toBe('default');
    });
});