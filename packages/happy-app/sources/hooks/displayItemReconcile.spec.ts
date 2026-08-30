import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import type { AgentWorkGroupItem, ToolGroupItem } from './useGroupedMessages';
import { reconcileDisplayItems } from './displayItemReconcile';

function message(id: string): Message {
    return { kind: 'agent-text', id, localId: null, createdAt: 1, text: id } as Message;
}

function toolGroup(id: string, messages: Message[], hasRunning = false): ToolGroupItem {
    return { type: 'tool-group', id, messages, hasRunning, hasPendingPermission: false };
}

function workGroup(id: string, messages: Message[], completedAt: number | null): AgentWorkGroupItem {
    return {
        type: 'agent-work-group',
        id,
        messages,
        hasRunning: completedAt === null,
        hasPendingPermission: false,
        startedAt: 10,
        completedAt,
    };
}

describe('reconcileDisplayItems', () => {
    it('reuses an unchanged tool group', () => {
        const sharedMessages = [message('m1')];
        const previous = toolGroup('g1', sharedMessages);
        expect(reconcileDisplayItems([previous], [toolGroup('g1', sharedMessages)])[0]).toBe(previous);
    });

    it('keeps a new group when a member identity changes', () => {
        const previous = toolGroup('g1', [message('m1')]);
        const next = toolGroup('g1', [message('m1')]);
        expect(reconcileDisplayItems([previous], [next])[0]).toBe(next);
    });

    it('keeps a new group when running state changes', () => {
        const sharedMessages = [message('m1')];
        const previous = toolGroup('g1', sharedMessages);
        const next = toolGroup('g1', sharedMessages, true);
        expect(reconcileDisplayItems([previous], [next])[0]).toBe(next);
    });

    it('keeps a new work group when completion time changes', () => {
        const sharedMessages = [message('m1')];
        const previous = workGroup('w1', sharedMessages, null);
        const next = workGroup('w1', sharedMessages, 42);
        expect(reconcileDisplayItems([previous], [next])[0]).toBe(next);
    });

    it('reuses an unchanged completed work group', () => {
        const sharedMessages = [message('m1')];
        const previous = workGroup('w1', sharedMessages, 42);
        expect(reconcileDisplayItems([previous], [workGroup('w1', sharedMessages, 42)])[0]).toBe(previous);
    });
});
