import { Message } from './typesMessage';

/**
 * Incremental maintenance of a session's message list.
 *
 * The list is newest-first, descending by createdAt. Rebuilding it from a
 * cloned lookup plus a full sort on every incoming message was the largest
 * per-message cost in the store, and it grew with session length.
 */

/**
 * Above this batch size one sort beats repeated splices: each splice costs
 * O(current) while a sort costs O(current log current), so splicing only wins
 * while the batch is smaller than log2(current) — about 11 at 2000 messages.
 * Streaming delivers one or two at a time; older-page loads deliver ~100.
 */
const BULK_MERGE_THRESHOLD = 8;

function sortNewestFirst(messages: Message[]): Message[] {
    return messages.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Index at which a message with `createdAt` belongs, placed after every entry
 * whose createdAt is greater than or equal to it. That reproduces the stable
 * sort this replaces, where lookup insertion order decided ties.
 */
function findInsertIndex(messages: Message[], createdAt: number): number {
    let lo = 0;
    let hi = messages.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (messages[mid].createdAt >= createdAt) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * Merges `incoming` into `current`, mutating `lookup` in place.
 *
 * The lookup is mutated deliberately: cloning it was the single largest
 * measured cost, and nothing relies on its identity for change detection —
 * the reducer supplies new Message objects for changed ids. A fresh array is
 * returned whenever anything changed, so store consumers still see a new value.
 */
export function mergeMessagesInto(
    current: Message[],
    lookup: Map<string, Message>,
    incoming: Message[],
): Message[] {
    if (incoming.length === 0) {
        return current;
    }

    // An update that moves createdAt would invalidate the ordering assumption
    // behind incremental insertion. Re-sort rather than emit a misordered list.
    let requiresResort = false;
    for (const message of incoming) {
        const existing = lookup.get(message.id);
        if (existing && existing.createdAt !== message.createdAt) {
            requiresResort = true;
            break;
        }
    }

    if (requiresResort || incoming.length > BULK_MERGE_THRESHOLD) {
        for (const message of incoming) {
            lookup.set(message.id, message);
        }
        return sortNewestFirst([...lookup.values()]);
    }

    const next = current.slice();
    for (const message of incoming) {
        const existing = lookup.get(message.id);
        lookup.set(message.id, message);
        if (existing) {
            // A linear scan here is deliberate: it is O(current) but on the
            // order of microseconds even at 8000 messages, and far simpler to
            // reason about than a binary search across a run of equal
            // createdAt values.
            const index = next.indexOf(existing);
            if (index !== -1) {
                next[index] = message;
                continue;
            }
            // In the lookup but absent from the array — insert instead of
            // silently dropping it.
        }
        next.splice(findInsertIndex(next, message.createdAt), 0, message);
    }
    return next;
}
