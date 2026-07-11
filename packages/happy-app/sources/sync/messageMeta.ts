import type { Session } from './storageTypes';
import type { Settings } from './settings';
import { getAgentDefaultOverride } from './agentDefaults';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import {
    getRigCurrentModel,
    getRigModels,
    getRigReasoningLevels,
    getRigReasoningSelection,
    getRigSelectedModelKey,
    isRigMetadataV1,
} from './rig';
import {
    getDefaultEffortKeyForModel,
    getEffortLevelsForModel,
} from '@/components/modelModeOptions';

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    model?: string | null;
    modelProviderId?: string;
    effort?: string | null;
};

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'>,
    settings?: Pick<Settings, 'agentDefaultOverrides'>,
): MessageModeMeta {
    if (isRigMetadataV1(session.metadata)) {
        const meta: MessageModeMeta = {};
        const permissionMode = session.permissionMode
            ?? session.metadata?.currentOperatingModeCode
            ?? session.metadata?.permissionMode
            ?? session.metadata?.session?.permissionMode;
        if (permissionMode) meta.permissionMode = permissionMode;

        const selectedKey = session.modelMode ?? getRigSelectedModelKey(session.metadata);
        const selectedModel = getRigModels(session.metadata).find((model) => model.key === selectedKey)
            ?? (selectedKey === getRigSelectedModelKey(session.metadata) ? getRigCurrentModel(session.metadata) : null);
        if (selectedModel) {
            meta.model = selectedModel.id;
            meta.modelProviderId = selectedModel.providerId;
        } else if (selectedKey?.includes(':')) {
            const separator = selectedKey.indexOf(':');
            meta.modelProviderId = selectedKey.slice(0, separator);
            meta.model = selectedKey.slice(separator + 1);
        }

        const levels = getRigReasoningLevels(session.metadata, selectedKey);
        const localEffort = session.effortLevel;
        const effort = localEffort && levels.includes(localEffort)
            ? localEffort
            : getRigReasoningSelection(session.metadata, selectedKey);
        if (effort) meta.effort = effort;
        return meta;
    }

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
