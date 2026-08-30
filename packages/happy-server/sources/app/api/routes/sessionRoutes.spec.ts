import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

type SessionRecord = {
    id: string;
    accountId: string;
    seq: number;
    createdAt: Date;
    updatedAt: Date;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date;
};

const {
    state,
    dbMock,
    resetState,
    seedSession
} = vi.hoisted(() => {
    const state = {
        sessions: [] as SessionRecord[]
    };

    const resetState = () => {
        state.sessions = [];
    };

    const seedSession = (session: SessionRecord) => {
        state.sessions.push(session);
    };

    const selectFields = <T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) => {
        if (!select) {
            return { ...row };
        }

        const selected: Record<string, unknown> = {};
        for (const [field, enabled] of Object.entries(select)) {
            if (enabled) {
                selected[field] = row[field];
            }
        }
        return selected;
    };

    const sessionFindFirst = vi.fn(async (args: any) => {
        const session = state.sessions.find((item) => (
            item.id === args?.where?.id && item.accountId === args?.where?.accountId
        ));
        return session
            ? selectFields(session as unknown as Record<string, unknown>, args?.select)
            : null;
    });

    const sessionFindMany = vi.fn(async (args: any) => state.sessions
        .filter((item) => item.accountId === args?.where?.accountId)
        .map((item) => selectFields(item as unknown as Record<string, unknown>, args?.select)));

    const sessionMessageFindMany = vi.fn(async () => []);

    const dbMock = {
        session: {
            findFirst: sessionFindFirst,
            findMany: sessionFindMany
        },
        sessionMessage: {
            findMany: sessionMessageFindMany
        }
    };

    return { state, dbMock, resetState, seedSession };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        emitUpdate: vi.fn(),
        emitEphemeral: vi.fn()
    },
    buildNewSessionUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn()
}));
vi.mock("@/storage/seq", () => ({ allocateUserSeq: vi.fn() }));
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked: vi.fn() }));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete: vi.fn() }));

import { sessionRoutes } from "./sessionRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    sessionRoutes(typed);
    await typed.ready();
    return typed;
}

function sessionFixture(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: "session-1",
        accountId: "owner-1",
        seq: 42,
        createdAt: new Date("2026-08-29T01:02:03.000Z"),
        updatedAt: new Date("2026-08-30T04:05:06.000Z"),
        metadata: "encrypted-metadata",
        metadataVersion: 7,
        agentState: "encrypted-agent-state",
        agentStateVersion: 9,
        dataEncryptionKey: Uint8Array.from([0, 1, 2, 253, 254, 255]),
        active: true,
        lastActiveAt: new Date("2026-08-30T03:04:05.000Z"),
        ...overrides
    };
}

describe("sessionRoutes - GET /v1/sessions/:sessionId", () => {
    let app: Fastify;

    beforeEach(() => {
        resetState();
        vi.clearAllMocks();
    });

    afterEach(async () => {
        if (app) {
            await app.close();
        }
    });

    it("returns the owner's session with ciphertext, versions, timestamps, and base64 key intact", async () => {
        const stored = sessionFixture();
        seedSession(stored);
        app = await createApp();

        const response = await app.inject({
            method: "GET",
            url: "/v1/sessions/session-1",
            headers: { "x-user-id": "owner-1" }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            session: {
                id: "session-1",
                seq: 42,
                createdAt: stored.createdAt.getTime(),
                updatedAt: stored.updatedAt.getTime(),
                active: true,
                activeAt: stored.lastActiveAt.getTime(),
                metadata: "encrypted-metadata",
                metadataVersion: 7,
                agentState: "encrypted-agent-state",
                agentStateVersion: 9,
                dataEncryptionKey: Buffer.from(stored.dataEncryptionKey!).toString("base64"),
                lastMessage: null
            }
        });
        expect(dbMock.session.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "session-1", accountId: "owner-1" }
        }));
    });

    it("returns 404 when the session belongs to another account", async () => {
        seedSession(sessionFixture());
        app = await createApp();

        const response = await app.inject({
            method: "GET",
            url: "/v1/sessions/session-1",
            headers: { "x-user-id": "other-account" }
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "Session not found" });
    });

    it("returns 404 when the session does not exist", async () => {
        app = await createApp();

        const response = await app.inject({
            method: "GET",
            url: "/v1/sessions/missing-session",
            headers: { "x-user-id": "owner-1" }
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "Session not found" });
    });

    it("returns 401 when unauthenticated", async () => {
        seedSession(sessionFixture());
        app = await createApp();

        const response = await app.inject({
            method: "GET",
            url: "/v1/sessions/session-1"
        });

        expect(response.statusCode).toBe(401);
        expect(dbMock.session.findFirst).not.toHaveBeenCalled();
    });

    it("does not shadow the existing list and nested messages routes", async () => {
        seedSession(sessionFixture());
        app = await createApp();

        const listResponse = await app.inject({
            method: "GET",
            url: "/v1/sessions",
            headers: { "x-user-id": "owner-1" }
        });
        const messagesResponse = await app.inject({
            method: "GET",
            url: "/v1/sessions/session-1/messages",
            headers: { "x-user-id": "owner-1" }
        });

        expect(listResponse.statusCode).toBe(200);
        expect(listResponse.json().sessions).toHaveLength(1);
        expect(messagesResponse.statusCode).toBe(200);
        expect(messagesResponse.json()).toEqual({ messages: [] });
    });
});
