import type { Message } from './typesMessage';

const BULK_MERGE_THRESHOLD = 8;

function sortNewestFirst(messages: Message[]): Message[] {
    return messages.sort((left, right) => right.createdAt - left.createdAt);
}

function findInsertIndex(messages: Message[], createdAt: number): number {
    let low = 0;
    let high = messages.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (messages[middle].createdAt >= createdAt) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

/**
 * Incrementally maintain the newest-first message array while mutating its
 * private ID lookup. Streaming batches avoid cloning and sorting the entire
 * session; large history pages still take the cheaper one-sort path.
 */
export function mergeMessagesInto(
    current: Message[],
    lookup: Record<string, Message>,
    incoming: Message[],
): Message[] {
    if (incoming.length === 0) {
        return current;
    }

    const requiresResort = incoming.some((message) => {
        const existing = lookup[message.id];
        return existing !== undefined && existing.createdAt !== message.createdAt;
    });

    if (requiresResort || incoming.length > BULK_MERGE_THRESHOLD) {
        for (const message of incoming) {
            lookup[message.id] = message;
        }
        return sortNewestFirst(Object.values(lookup));
    }

    const next = current.slice();
    for (const message of incoming) {
        const existing = lookup[message.id];
        lookup[message.id] = message;

        if (existing) {
            let index = next.indexOf(existing);
            if (index === -1) {
                // Be robust to an already-inconsistent lookup/array pair and
                // replace by ID instead of introducing a duplicate row.
                index = next.findIndex((candidate) => candidate.id === message.id);
            }
            if (index !== -1) {
                next[index] = message;
                continue;
            }
        }
        next.splice(findInsertIndex(next, message.createdAt), 0, message);
    }
    return next;
}
