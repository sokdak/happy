// Type-only so the edge back to useGroupedMessages is erased at compile time.
// A value import here would create a real circular dependency.
import type { AgentWorkGroupItem, DisplayItem, ToolGroupItem } from './useGroupedMessages';
import type { Message } from '@/sync/typesMessage';

/**
 * Restores object identity for group display items across regroupings.
 *
 * groupMessagesForDisplay allocates fresh group objects every call, so
 * ToolGroupView and AgentWorkGroupView saw a changed prop on every streamed
 * token and their React.memo never held. Message items already carry a stable
 * message reference for unchanged messages and need no help here.
 */

type GroupItem = ToolGroupItem | AgentWorkGroupItem;

function isGroup(item: DisplayItem): item is GroupItem {
    return item.type === 'tool-group' || item.type === 'agent-work-group';
}

function sameMessages(a: Message[], b: Message[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        // Reference equality is the right test: the reducer emits new Message
        // objects for changed messages and preserves identity for unchanged.
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function isEquivalent(prev: GroupItem, next: GroupItem): boolean {
    if (prev.type !== next.type) {
        return false;
    }
    if (prev.hasRunning !== next.hasRunning) {
        return false;
    }
    if (prev.hasPendingPermission !== next.hasPendingPermission) {
        return false;
    }
    if (prev.type === 'agent-work-group' && next.type === 'agent-work-group') {
        // AgentWorkGroupView renders elapsed time from these, so ignoring them
        // would freeze the timer.
        if (prev.startedAt !== next.startedAt || prev.completedAt !== next.completedAt) {
            return false;
        }
    }
    return sameMessages(prev.messages, next.messages);
}

export function reconcileDisplayItems(prev: DisplayItem[], next: DisplayItem[]): DisplayItem[] {
    if (prev.length === 0 || next.length === 0) {
        return next;
    }

    const previousGroups = new Map<string, GroupItem>();
    for (const item of prev) {
        if (isGroup(item)) {
            previousGroups.set(item.id, item);
        }
    }
    if (previousGroups.size === 0) {
        return next;
    }

    let changed = false;
    const result = next.map((item) => {
        if (!isGroup(item)) {
            return item;
        }
        const previous = previousGroups.get(item.id);
        if (previous && isEquivalent(previous, item)) {
            changed = true;
            return previous;
        }
        return item;
    });

    return changed ? result : next;
}
