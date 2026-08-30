import type { Message } from '@/sync/typesMessage';
import type { AgentWorkGroupItem, DisplayItem, ToolGroupItem } from './useGroupedMessages';

type GroupItem = ToolGroupItem | AgentWorkGroupItem;

function isGroup(item: DisplayItem): item is GroupItem {
    return item.type === 'tool-group' || item.type === 'agent-work-group';
}

function hasSameMessages(previous: Message[], next: Message[]): boolean {
    if (previous.length !== next.length) {
        return false;
    }
    for (let index = 0; index < previous.length; index += 1) {
        if (previous[index] !== next[index]) {
            return false;
        }
    }
    return true;
}

function isEquivalent(previous: GroupItem, next: GroupItem): boolean {
    if (previous.type !== next.type
        || previous.hasRunning !== next.hasRunning
        || previous.hasPendingPermission !== next.hasPendingPermission
        || !hasSameMessages(previous.messages, next.messages)) {
        return false;
    }
    if (previous.type === 'agent-work-group' && next.type === 'agent-work-group') {
        return previous.startedAt === next.startedAt
            && previous.completedAt === next.completedAt;
    }
    return true;
}

/** Preserve unchanged group objects so memoized rows can skip streamed updates. */
export function reconcileDisplayItems(previous: DisplayItem[], next: DisplayItem[]): DisplayItem[] {
    if (previous.length === 0 || next.length === 0) {
        return next;
    }

    const previousGroups = new Map<string, GroupItem>();
    for (const item of previous) {
        if (isGroup(item)) {
            previousGroups.set(item.id, item);
        }
    }
    if (previousGroups.size === 0) {
        return next;
    }

    return next.map((item) => {
        if (!isGroup(item)) {
            return item;
        }
        const oldItem = previousGroups.get(item.id);
        return oldItem && isEquivalent(oldItem, item) ? oldItem : item;
    });
}
