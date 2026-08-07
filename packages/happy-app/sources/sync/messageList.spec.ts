import { describe, expect, it } from 'vitest';
import { mergeMessagesInto } from './messageList';
import { Message } from './typesMessage';

function msg(id: string, createdAt: number): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text: id } as Message;
}

/** Builds the newest-first array plus its lookup, the way the store holds them. */
function seed(messages: Message[]): { current: Message[]; lookup: Map<string, Message> } {
    const lookup = new Map<string, Message>();
    for (const m of messages) lookup.set(m.id, m);
    const current = [...messages].sort((a, b) => b.createdAt - a.createdAt);
    return { current, lookup };
}

function ids(messages: Message[]): string[] {
    return messages.map((m) => m.id);
}

describe('mergeMessagesInto', () => {
    it('returns the same reference when nothing is incoming', () => {
        const { current, lookup } = seed([msg('a', 1)]);
        expect(mergeMessagesInto(current, lookup, [])).toBe(current);
    });

    it('places a newer message at the head', () => {
        const { current, lookup } = seed([msg('a', 1), msg('b', 2)]);
        const next = mergeMessagesInto(current, lookup, [msg('c', 3)]);
        expect(ids(next)).toEqual(['c', 'b', 'a']);
    });

    it('inserts into the middle at the right index', () => {
        const { current, lookup } = seed([msg('a', 1), msg('c', 3)]);
        const next = mergeMessagesInto(current, lookup, [msg('b', 2)]);
        expect(ids(next)).toEqual(['c', 'b', 'a']);
    });

    it('places an older message at the tail', () => {
        const { current, lookup } = seed([msg('b', 2), msg('c', 3)]);
        const next = mergeMessagesInto(current, lookup, [msg('a', 1)]);
        expect(ids(next)).toEqual(['c', 'b', 'a']);
    });

    it('replaces an existing id in place without changing order or length', () => {
        const { current, lookup } = seed([msg('a', 1), msg('b', 2), msg('c', 3)]);
        const updated = msg('b', 2);
        const next = mergeMessagesInto(current, lookup, [updated]);
        expect(ids(next)).toEqual(['c', 'b', 'a']);
        expect(next).toHaveLength(3);
        expect(next[1]).toBe(updated);
        expect(lookup.get('b')).toBe(updated);
    });

    it('keeps insertion order among equal createdAt values', () => {
        const { current, lookup } = seed([msg('first', 5)]);
        const next = mergeMessagesInto(current, lookup, [msg('second', 5)]);
        expect(ids(next)).toEqual(['first', 'second']);
        const after = mergeMessagesInto(next, lookup, [msg('third', 5)]);
        expect(ids(after)).toEqual(['first', 'second', 'third']);
    });

    it('matches a full concat-and-sort for a bulk batch', () => {
        const existing = [msg('e1', 100), msg('e2', 101)];
        const { current, lookup } = seed(existing);
        const older = Array.from({ length: 20 }, (_, i) => msg(`o${i}`, i));
        const next = mergeMessagesInto(current, lookup, older);
        const expected = [...existing, ...older].sort((a, b) => b.createdAt - a.createdAt);
        expect(ids(next)).toEqual(ids(expected));
    });

    it('falls back to a full re-sort when an update moves createdAt', () => {
        const { current, lookup } = seed([msg('a', 1), msg('b', 2), msg('c', 3)]);
        const moved = msg('a', 99);
        const next = mergeMessagesInto(current, lookup, [moved]);
        expect(ids(next)).toEqual(['a', 'c', 'b']);
        expect(next).toHaveLength(3);
    });

    it('mutates the supplied lookup rather than replacing it', () => {
        const { current, lookup } = seed([msg('a', 1)]);
        const added = msg('b', 2);
        mergeMessagesInto(current, lookup, [added]);
        expect(lookup.size).toBe(2);
        expect(lookup.get('b')).toBe(added);
    });

    it('does not mutate the input array', () => {
        const { current, lookup } = seed([msg('a', 1)]);
        const next = mergeMessagesInto(current, lookup, [msg('b', 2)]);
        expect(next).not.toBe(current);
        expect(ids(current)).toEqual(['a']);
    });
});
