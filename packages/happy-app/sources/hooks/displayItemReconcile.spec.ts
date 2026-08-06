import { describe, expect, it } from 'vitest';
import { reconcileDisplayItems } from './displayItemReconcile';
import { AgentWorkGroupItem, DisplayItem, ToolGroupItem } from './useGroupedMessages';
import { Message } from '@/sync/typesMessage';

function msg(id: string): Message {
    return { kind: 'agent-text', id, localId: null, createdAt: 1, text: id } as Message;
}

function toolGroup(id: string, messages: Message[], hasRunning = false): ToolGroupItem {
    return { type: 'tool-group', id, messages, hasRunning, hasPendingPermission: false };
}

function workGroup(id: string, messages: Message[], completedAt: number | null = null): AgentWorkGroupItem {
    return {
        type: 'agent-work-group',
        id,
        messages,
        hasRunning: false,
        hasPendingPermission: false,
        startedAt: 10,
        completedAt,
    };
}

describe('reconcileDisplayItems', () => {
    it('reuses the previous object when a tool group is unchanged', () => {
        const shared = [msg('m1')];
        const prevItem = toolGroup('g1', shared);
        const next = reconcileDisplayItems([prevItem], [toolGroup('g1', shared)]);
        expect(next[0]).toBe(prevItem);
    });

    it('keeps the new object when a member message identity changed', () => {
        const prevItem = toolGroup('g1', [msg('m1')]);
        const nextItem = toolGroup('g1', [msg('m1')]);
        const next = reconcileDisplayItems([prevItem], [nextItem]);
        expect(next[0]).toBe(nextItem);
    });

    it('keeps the new object when member count changed', () => {
        const shared = msg('m1');
        const prevItem = toolGroup('g1', [shared]);
        const nextItem = toolGroup('g1', [shared, msg('m2')]);
        const next = reconcileDisplayItems([prevItem], [nextItem]);
        expect(next[0]).toBe(nextItem);
    });

    it('keeps the new object when hasRunning changed', () => {
        const shared = [msg('m1')];
        const prevItem = toolGroup('g1', shared, false);
        const nextItem = toolGroup('g1', shared, true);
        const next = reconcileDisplayItems([prevItem], [nextItem]);
        expect(next[0]).toBe(nextItem);
    });

    it('keeps the new object when a work group completedAt changed', () => {
        const shared = [msg('m1')];
        const prevItem = workGroup('w1', shared, null);
        const nextItem = workGroup('w1', shared, 42);
        const next = reconcileDisplayItems([prevItem], [nextItem]);
        expect(next[0]).toBe(nextItem);
    });

    it('reuses the previous object when a work group is fully unchanged', () => {
        const shared = [msg('m1')];
        const prevItem = workGroup('w1', shared, 42);
        const next = reconcileDisplayItems([prevItem], [workGroup('w1', shared, 42)]);
        expect(next[0]).toBe(prevItem);
    });

    it('does not match across differing types with the same id', () => {
        const shared = [msg('m1')];
        const prevItem = toolGroup('same', shared);
        const nextItem = workGroup('same', shared);
        const next = reconcileDisplayItems([prevItem], [nextItem]);
        expect(next[0]).toBe(nextItem);
    });

    it('passes new groups through and drops removed ones', () => {
        const shared = [msg('m1')];
        const prevItem = toolGroup('g1', shared);
        const added = toolGroup('g2', shared);
        const next = reconcileDisplayItems([prevItem], [added]);
        expect(next).toHaveLength(1);
        expect(next[0]).toBe(added);
    });

    it('leaves message items untouched', () => {
        const item: DisplayItem = { type: 'message', id: 'm1', message: msg('m1') };
        const next = reconcileDisplayItems([], [item]);
        expect(next[0]).toBe(item);
    });

    it('returns the same array reference when every item was reused', () => {
        const shared = [msg('m1')];
        const prevItem = toolGroup('g1', shared);
        const nextArray = [toolGroup('g1', shared)];
        const next = reconcileDisplayItems([prevItem], nextArray);
        expect(next[0]).toBe(prevItem);
    });
});
