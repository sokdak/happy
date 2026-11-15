import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { MessageView } from '@/components/MessageView';
import { RequestUserInputCard } from '@/components/tools/views/RequestUserInputCard';
import type { AgentFormCommunication } from '@/sync/agentCommunications';
import type { AgentQuestion } from '@/sync/storageTypes';

const choice: AgentQuestion = {
    id: 'storage',
    header: 'Project order',
    question: 'Where should your custom project order be saved?',
    options: [
        { label: 'Sync across devices (Recommended)', description: 'Keep the same order on desktop, tablet, and phone.' },
        { label: 'Only on this device', description: 'Each device keeps its own project order.' },
    ],
    allowCustom: true,
    required: true,
};
const text: AgentQuestion = {
    id: 'details', header: 'Details', question: 'Are there any other details you want me to consider?',
    options: [], allowCustom: true, required: true,
};

/** Interactive fixture using the production card, without a live agent or RPC. */
export default function CodexQuestionsPreview() {
    const { scenario } = useLocalSearchParams<{ scenario?: string }>();
    const [revision, setRevision] = React.useState(0);
    const questions = scenario === 'text' ? [text] : scenario === 'multiple' ? [choice, text] : [choice];
    const communication: AgentFormCommunication = {
        id: `preview-${revision}`, toolUseId: 'preview-call', kind: 'form', status: 'pending', createdAt: 0, questions,
    };

    return (
        <>
            <Stack.Screen options={{ headerTitle: 'Codex questions' }} />
            <ScrollView style={styles.screen} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                <View style={styles.content}>
                    <Text style={styles.previewLabel}>INTERACTIVE PREVIEW · CODEX</Text>
                    <MessageView
                        sessionId="codex-question-preview" metadata={null}
                        message={{ kind: 'user-text', id: 'user', localId: null, createdAt: 0, text: 'Let me reorder projects in the sidebar and remember my order.' }}
                    />
                    <MessageView
                        sessionId="codex-question-preview" metadata={null}
                        message={{ kind: 'agent-text', id: 'agent', localId: null, createdAt: 0, text: 'I found the project list and settings store. Before I connect the persistence, I have a question about how this should work.' }}
                    />
                    <RequestUserInputCard
                        key={communication.id}
                        communication={communication}
                        canInteract
                        onSubmit={async () => { /* Preview: the card retains the submitted answers locally. */ }}
                        onCancel={async () => { /* Preview: no live request to cancel. */ }}
                    />
                    <Pressable accessibilityRole="button" onPress={() => setRevision(value => value + 1)} style={styles.reset}>
                        <Text style={styles.resetText}>Reset preview</Text>
                    </Pressable>
                </View>
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create(theme => ({
    screen: { flex: 1, backgroundColor: theme.colors.surface },
    scroll: { paddingVertical: 24 },
    content: { width: '100%', maxWidth: 800, alignSelf: 'center', paddingHorizontal: 16 },
    previewLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 1, color: theme.colors.textSecondary, marginBottom: 20 },
    reset: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, marginTop: 8 },
    resetText: { fontSize: 13, color: theme.colors.textLink },
}));
