import type { Session } from './storageTypes';
import type { Settings } from './settings';
import { getAgentDefaultOverride } from './agentDefaults';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import {
    getDefaultEffortKeyForModel,
    getEffortLevelsForModel,
} from '@/components/modelModeOptions';

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    model?: string | null;
    effort?: string | null;
};

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'>,
    settings?: Pick<Settings, 'agentDefaultOverrides'>,
): MessageModeMeta {
    const agentOverrides = getAgentDefaultOverride(settings?.agentDefaultOverrides, session.metadata?.flavor);
    const meta: MessageModeMeta = {};

    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        meta.permissionMode = session.permissionMode;
    } else if (agentOverrides.permissionMode !== undefined) {
        meta.permissionMode = agentOverrides.permissionMode;
    }

    const modelMode = session.modelMode ?? agentOverrides.modelMode;
    if (modelMode !== undefined) {
        meta.model = modelMode === 'default' ? null : modelMode;
    }

    const effort = session.effortLevel ?? agentOverrides.effortLevel;
    if (session.metadata?.flavor === 'claude') {
        const effortModel = modelMode && modelMode !== 'default'
            ? modelMode
            : (session.metadata.currentModelCode ?? modelMode ?? 'default');
        const supportedEfforts = getEffortLevelsForModel('claude', effortModel);

        // An omitted effort means "keep the current effort" to the CLI. Send
        // an explicit null for models such as Haiku that accept no effort, and
        // replace stale values (for example Opus xhigh -> Sonnet) with Happy's
        // supported default instead of leaking the hidden old selection.
        if (supportedEfforts.length === 0) {
            meta.effort = null;
        } else if (effort !== undefined) {
            meta.effort = supportedEfforts.some((option) => option.key === effort)
                ? effort
                : getDefaultEffortKeyForModel('claude', effortModel);
        }
    } else if (effort !== undefined) {
        meta.effort = effort;
    }

    return meta;
}
