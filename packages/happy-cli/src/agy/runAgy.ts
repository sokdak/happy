/**
 * Agy Session Runner
 *
 * Entry point for agy (Antigravity CLI) agent sessions, following the runOpenClaw.ts
 * pattern. The daemon spawns this as:
 *   `node dist/index.mjs agy --happy-starting-mode remote --started-by daemon`
 *
 * Uses persistent `agy acp` by default, with an explicit print-mode rollback switch.
 * Both adapters forward AgentMessage events through the existing Happy pipeline.
 */

import { agyReconnectSession } from './reconnect';
import { startAgyHappyMcp, AGY_TITLE_INSTRUCTION } from './happyMcp';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { render, type Instance as InkInstance } from 'ink';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { PermissionMode, UserMessage } from '@/api/types';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { AgyDisplay } from '@/ui/ink/AgyDisplay';
import type { AgentMessage } from '@/agent/core';
import { normalizeRemotePermissionMode } from '@/claude/utils/permissionMode';
import { AgyAcpBackend, AgyCancelledError } from './AgyAcpBackend';
import { createAgyBackend } from './createBackend';
import { AgyPermissionHandler } from './permissionHandler';
import { agyPromptImages } from './promptImages';
import {
  DEFAULT_AGY_EFFORT,
  DEFAULT_AGY_MODEL,
  normalizeAgyEffort,
  resolveAgyModelName,
} from './constants';

export interface RunAgyOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  /** Explicit native ACP session to load; never inferred from workspace cache. */
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
}

export async function runAgy(opts: RunAgyOptions): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend('agy');

  const log = (msg: string) => {
    logger.debug(`[agy] ${msg}`);
    if (verbose) {
      console.log(`[agy] ${msg}`);
    }
  };

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata: initialMetadata } = createSessionMetadata({
    flavor: 'agy',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
  });
  let metadata = initialMetadata;
  let nativeSessionId = opts.resumeSessionId;
  if (opts.resumeSessionId) metadata.agySessionId = opts.resumeSessionId;
  const reconnect = agyReconnectSession(metadata, state, opts.resumeSessionId);
  if (reconnect) metadata = reconnect.metadata;
  const response = reconnect ?? await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) {
    log(`Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  let permissionHandler: AgyPermissionHandler | undefined;
  let inputReady = false;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      permissionHandler?.updateSession(newSession);
      // The offline stub discards metadata writes. Re-publish an ACP ID that
      // arrived before the real Happy session existed so this chat can resume.
      if (nativeSessionId) {
        const agySessionId = nativeSessionId;
        newSession.updateMetadata(current => ({ ...current, agySessionId }));
      }
      if (inputReady) bindInput(newSession);
    },
  });
  session = initialSession;
  if (reconnect) {
    session.suppressNextArchiveSignal();
    session.skipExistingMessages();
    session.updateMetadata(current => ({ ...current, lifecycleState: 'running',
      lifecycleStateSince: Date.now(), archivedBy: undefined, archiveReason: undefined }));
  }

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[agy] Failed to report session to daemon:', error);
    }
  }

  const sessionManager = new AcpSessionManager({ preserveTextWhitespace: true, forwardToolResults: true });
  type TurnSettings = { model: string; effort: string; permissionMode: PermissionMode };
  const messageQueue = new MessageQueue2<TurnSettings>(JSON.stringify);
  let incomingPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
  let enqueueTail = Promise.resolve();
  let shouldExit = false;
  let abortController = new AbortController();
  let thinking = false;
  let errorReportedForCurrentTurn = false;

  let selectedModel = opts.model ?? DEFAULT_AGY_MODEL;
  let selectedEffort = opts.effort ? normalizeAgyEffort(opts.effort) : DEFAULT_AGY_EFFORT;
  let displayedModel = resolveAgyModelName(selectedModel, selectedEffort);

  permissionHandler = new AgyPermissionHandler(session);
  const happyServer = (process.env.HAPPY_AGY_TRANSPORT ?? 'acp') === 'acp'
    ? await startAgyHappyMcp(() => session) : undefined;
  let backend: ReturnType<typeof createAgyBackend>;
  try {
    backend = createAgyBackend({
      mcpServers: happyServer?.mcpServers,
      initialPrompt: happyServer ? AGY_TITLE_INSTRUCTION : undefined,
      cwd: process.cwd(),
      permissionMode: incomingPermissionMode,
      model: selectedModel,
      effort: selectedEffort,
      resumeSessionId: opts.resumeSessionId,
      requestPermission: (id, tool, input) => permissionHandler!.handleToolCall(id, tool, input),
      resetPermissions: () => permissionHandler?.reset(),
      log,
    });
  } catch (error) {
    happyServer?.stop();
    reconnectionHandle?.cancel();
    throw error;
  }

  // Terminal UI (only with a real TTY; the daemon runs headless).
  const messageBuffer = new MessageBuffer();
  const hasTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let inkInstance: InkInstance | null = null;

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      session.sendSessionProtocolMessage(envelope);
    }
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      log(`Backend message: ${msg.type}`);
    }

    if (msg.type === 'event' && msg.name === 'agy_session_id' && typeof msg.payload === 'string') {
      const agySessionId = msg.payload;
      nativeSessionId = agySessionId;
      session.updateMetadata(current => ({ ...current, agySessionId }));
    }

    if (msg.type === 'model-output' && msg.textDelta) {
      messageBuffer.addMessage(msg.textDelta, 'assistant');
    } else if (msg.type === 'tool-call') {
      const target =
        typeof msg.args.file_path === 'string'
          ? msg.args.file_path
          : typeof msg.args.command === 'string'
            ? msg.args.command
            : typeof msg.args.path === 'string'
              ? msg.args.path
              : typeof msg.args.pattern === 'string'
                ? msg.args.pattern
                : typeof msg.args.query === 'string'
                  ? msg.args.query
                  : typeof msg.args.url === 'string'
                    ? msg.args.url
                    : typeof msg.args.description === 'string'
                      ? msg.args.description
                      : '';
      messageBuffer.addMessage(
        target ? `${msg.toolName}: ${target}` : msg.toolName,
        'tool',
      );
    } else if (msg.type === 'status') {
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
      if (msg.status === 'error' && msg.detail) {
        messageBuffer.addMessage(`Error: ${msg.detail}`, 'status');
      }
    }

    const envelopes = sessionManager.mapMessage(msg);
    sendEnvelopes(envelopes);
    if (msg.type === 'status' && msg.status === 'error' && envelopes.length === 0) {
      session.sendSessionEvent({
        type: 'message',
        message: `Antigravity error: ${msg.detail?.trim() || 'The agent stopped because of an unknown error.'}`,
      });
    }
    if (msg.type === 'status' && msg.status === 'error') {
      errorReportedForCurrentTurn = true;
    }
  };

  backend.onMessage(onBackendMessage);

  if (hasTTY) {
    const DisplayComponent = () =>
      React.createElement(AgyDisplay, {
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        currentModel: displayedModel,
        onExit: async () => {
          logger.debug('[agy] Exiting agent via Ctrl-C');
          await shutdown();
        },
      });

    inkInstance = render(React.createElement(DisplayComponent), {
      exitOnCtrlC: false,
      patchConsole: false,
    });
    messageBuffer.addMessage(`[MODEL:${displayedModel}]`, 'system');

    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  function bindInput(inputSession: ApiSessionClient) {
    inputSession.onFileEvent?.((message) => {
      const file = message.content.data.ev;
      const download = inputSession.downloadAndDecryptAttachment(file.ref).then(data => {
        if (!data) throw new Error('Antigravity attachment could not be decrypted');
        return { data, mimeType: file.mimeType ?? '', name: file.name };
      });
      // Retain the rejection for this message, but prevent an unhandled rejection
      // if its paired user text has not arrived yet.
      void download.catch(() => {});
      inputSession.trackAttachmentDownload(download);
    });
    inputSession.onUserMessage((message) => {
      if (typeof inputSession.drainAttachmentsForUserMessage !== 'function') {
        // Offline registrations are transferred before onSessionSwap runs.
        // Defer only that stub callback so it uses the real session's attachments.
        queueMicrotask(() => receiveUserMessage(session, message));
      } else {
        receiveUserMessage(inputSession, message);
      }
    });
  }
  function receiveUserMessage(inputSession: ApiSessionClient, message: UserMessage) {
    const attachmentPromise = inputSession.drainAttachmentsForUserMessage();
    void attachmentPromise.catch(() => {});
    if (message.meta?.permissionMode) {
      incomingPermissionMode = normalizeRemotePermissionMode(message.meta.permissionMode) ?? incomingPermissionMode;
    }
    if (message.meta?.model) selectedModel = message.meta.model;
    if (message.meta?.hasOwnProperty('effort')) selectedEffort = normalizeAgyEffort(message.meta.effort);
    const turnSettings: TurnSettings = { model: selectedModel, effort: selectedEffort, permissionMode: incomingPermissionMode };
    // Preserve message arrival order even when attachment downloads finish out of order.
    enqueueTail = enqueueTail.then(async () => {
      const attachments = await attachmentPromise;
      if (shouldExit || (!message.content.text && !attachments.length)) return;
      messageBuffer.addMessage(message.content.text, 'user');
      messageQueue.push(message.content.text, turnSettings, attachments);
    }).catch(() => {
      if (shouldExit) return;
      session.sendSessionEvent({ type: 'message', message: "Antigravity could not receive this message's attachment. Please send it again." });
    });
  }

  bindInput(session);
  inputReady = true;
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);
  // Each text envelope is a complete Markdown block in the app, not a delta.
  // Flush on tool/type boundaries and turn completion, as the Codex runner does.

  async function handleAbort() {
    log('Abort requested');
    try {
      await backend.cancel();
    } catch (error) {
      logger.debug('[agy] Abort failed:', error);
    }
    thinking = false;
    session.keepAlive(false, 'remote');
    abortController.abort();
    abortController = new AbortController();
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  let shutdownPromise: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    if (!shutdownPromise) {
      shouldExit = true;
      messageQueue.close();
      shutdownPromise = (async () => {
        await handleAbort();
        await backend.dispose();
      })();
    }
    return shutdownPromise;
  }
  registerKillSessionHandler(session, shutdown);
  const onSignal = () => { void shutdown(); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    await backend.startSession();
    log('Backend ready');

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      log('Processing queued Antigravity turn');
      backend.setModel(batch.mode.model);
      backend.setEffort(batch.mode.effort);
      backend.setPermissionMode(batch.mode.permissionMode);
      displayedModel = resolveAgyModelName(batch.mode.model, batch.mode.effort);
      if (hasTTY) messageBuffer.addMessage(`[MODEL:${displayedModel}]`, 'system');
      errorReportedForCurrentTurn = false;
      sendEnvelopes(sessionManager.startTurn());
      try {
        if (backend instanceof AgyAcpBackend) {
          await backend.sendPrompt(process.cwd(), batch.message, agyPromptImages(batch.attachments ?? []));
        } else {
          if (batch.attachments?.length) throw new Error('Image input requires the ACP transport');
          await backend.sendPrompt(process.cwd(), batch.message);
        }
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        if (error instanceof AgyCancelledError) {
          sendEnvelopes(sessionManager.endTurn('cancelled'));
        } else {
          const msg = error instanceof Error ? error.message : String(error);
          if (!errorReportedForCurrentTurn) {
            session.sendSessionEvent({ type: 'message', message: `Antigravity error: ${msg}` });
            errorReportedForCurrentTurn = true;
          }
          log(`Turn ended: ${msg}`);
          sendEnvelopes(sessionManager.endTurn('failed'));
        }
      }
      thinking = false;
      session.keepAlive(false, 'remote');
      session.sendSessionEvent({ type: 'ready' });
    }
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    shouldExit = true;
    messageQueue.close();
    permissionHandler?.reset();
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    backend.offMessage(onBackendMessage);
    try { await backend.dispose(); } finally { happyServer?.stop(); }
    inkInstance?.unmount();

    try {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug('[agy] Session close failed:', error);
    }
  }
}
