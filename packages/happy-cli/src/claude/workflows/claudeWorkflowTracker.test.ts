import { describe, expect, it } from 'vitest';
import { reduceClaudeWorkflowMessage, type ClaudeWorkflowReducerState } from './claudeWorkflowTracker';

const system = (subtype: string, fields: Record<string, unknown>) => ({
  type: 'system',
  subtype,
  uuid: `fixture-${subtype}`,
  ...fields,
});

const started = (taskId = 'workflow-1') => system('task_started', {
  task_id: taskId,
  tool_use_id: `tool-${taskId}`,
  task_type: 'local_workflow',
  workflow_name: 'inspect-packages',
  description: 'Read both package manifests',
});

const fullProgress = system('task_progress', {
  task_id: 'workflow-1',
  summary: 'Reading package manifests',
  usage: { total_tokens: 24600, tool_uses: 2, duration_ms: 18000 },
  workflow_progress: [
    { type: 'workflow_phase', index: 2, title: 'Read CLI' },
    { type: 'workflow_phase', index: 1, title: 'Read app' },
    { type: 'workflow_agent', index: 2, label: 'happy-cli', phaseIndex: 2, phaseTitle: 'Read CLI', agentId: 'agent-cli', model: 'claude-sonnet-5', state: 'start', lastToolName: 'Read', lastToolSummary: 'packages/happy-cli/package.json' },
    { type: 'workflow_agent', index: 1, label: 'happy-app', phaseIndex: 1, phaseTitle: 'Read app', agentId: 'agent-app', model: 'claude-sonnet-5', state: 'done', lastToolName: 'Read', lastToolSummary: 'packages/happy-app/package.json' },
  ],
});

const background = (tasks: unknown[]) => system('background_tasks_changed', { background_tasks: tasks });

const activeWorkflow = (taskId = 'workflow-1') => ({
  task_id: taskId,
  task_type: 'local_workflow',
  workflow_name: 'Native workflow',
});

describe('reduceClaudeWorkflowMessage', () => {
  it('creates only local workflows from a complete background snapshot and publishes immediately', () => {
    const result = reduceClaudeWorkflowMessage({}, background([
      activeWorkflow(),
      { task_id: 'agent-1', task_type: 'agent' },
      { task_id: 'shell-1', task_type: 'shell' },
    ]), 1000);

    expect(result).toEqual({
      state: {
        'workflow-1': { taskId: 'workflow-1', name: 'Native workflow', startedAt: 1000, updatedAt: 1000, phases: [] },
      },
      publication: 'immediate',
    });
  });

  it('enriches a fallback workflow without resetting its start time', () => {
    const fallback = reduceClaudeWorkflowMessage({}, background([activeWorkflow()]), 1000).state;
    const result = reduceClaudeWorkflowMessage(fallback, started(), 1100);

    expect(result).toMatchObject({
      publication: 'immediate',
      state: {
        'workflow-1': {
          taskId: 'workflow-1',
          toolUseId: 'tool-workflow-1',
          name: 'inspect-packages',
          description: 'Read both package manifests',
          startedAt: 1000,
          updatedAt: 1100,
          phases: [],
        },
      },
    });
  });

  it('groups sorted phases and maps workflow progress usage', () => {
    const state = reduceClaudeWorkflowMessage({}, started(), 1000).state;
    const result = reduceClaudeWorkflowMessage(state, fullProgress, 1200);
    const workflow = result.state['workflow-1'];

    expect(result.publication).toBe('progress');
    expect(workflow.usage).toEqual({ totalTokens: 24600, toolUses: 2, durationMs: 18000 });
    expect(workflow.phases.map((phase) => phase.index)).toEqual([1, 2]);
    expect(workflow.phases[0].agents[0]).toMatchObject({ id: 'agent-app', index: 1, state: 'done', lastToolName: 'Read' });
  });

  it('places an agent with an unknown phase in Other', () => {
    const state = reduceClaudeWorkflowMessage({}, started(), 1000).state;
    const result = reduceClaudeWorkflowMessage(state, system('task_progress', {
      task_id: 'workflow-1',
      workflow_progress: [{ type: 'workflow_agent', index: 1, label: 'orphan', agentId: 'agent-orphan', phaseIndex: 99, state: 'start' }],
    }), 1100);

    expect(result.state['workflow-1'].phases).toEqual([{ index: -1, title: 'Other', agents: [expect.objectContaining({ id: 'agent-orphan' })] }]);
  });

  it('keeps hierarchy and merges partial heartbeat usage', () => {
    const progressed = reduceClaudeWorkflowMessage(reduceClaudeWorkflowMessage({}, started(), 1000).state, fullProgress, 1100).state;
    const result = reduceClaudeWorkflowMessage(progressed, system('task_progress', {
      task_id: 'workflow-1', usage: { total_tokens: 25000 },
    }), 1200);

    expect(result.state['workflow-1'].phases).toBe(progressed['workflow-1'].phases);
    expect(result.state['workflow-1'].usage).toEqual({ totalTokens: 25000, toolUses: 2, durationMs: 18000 });
  });

  it('skips malformed workflow entries while retaining valid entries', () => {
    const state = reduceClaudeWorkflowMessage({}, started(), 1000).state;
    const result = reduceClaudeWorkflowMessage(state, system('task_progress', {
      task_id: 'workflow-1',
      workflow_progress: [
        { type: 'workflow_phase', index: 1, title: 'Valid' },
        { type: 'workflow_phase', index: 'bad', title: 'Invalid' },
        { type: 'workflow_agent', index: 1, label: 'valid', agentId: 'agent-valid', phaseIndex: 1, state: 'start' },
        { type: 'workflow_agent', index: 2, label: '', agentId: 'agent-invalid', phaseIndex: 1, state: 'start' },
      ],
    }), 1100);

    expect(result.state['workflow-1'].phases).toEqual([{ index: 1, title: 'Valid', agents: [expect.objectContaining({ id: 'agent-valid' })] }]);
  });

  it('updates a workflow agent in place without duplication', () => {
    const initial = reduceClaudeWorkflowMessage(reduceClaudeWorkflowMessage({}, started(), 1000).state, fullProgress, 1100).state;
    const result = reduceClaudeWorkflowMessage(initial, system('task_progress', {
      task_id: 'workflow-1',
      usage: { duration_ms: 22000 },
      workflow_progress: [
        { type: 'workflow_phase', index: 1, title: 'Read app' },
        { type: 'workflow_phase', index: 2, title: 'Read CLI' },
        { type: 'workflow_agent', index: 2, label: 'happy-cli', phaseIndex: 2, phaseTitle: 'Read CLI', agentId: 'agent-cli', state: 'done' },
        { type: 'workflow_agent', index: 1, label: 'happy-app', phaseIndex: 1, phaseTitle: 'Read app', agentId: 'agent-app', state: 'done' },
      ],
    }), 1200);

    const cliAgents = result.state['workflow-1'].phases.flatMap((phase) => phase.agents).filter((agent) => agent.id === 'agent-cli');
    expect(cliAgents).toHaveLength(1);
    expect(cliAgents[0].state).toBe('done');
    expect(result.state['workflow-1'].usage?.durationMs).toBe(22000);
  });

  it('removes only the completed workflow for concurrent terminal events', () => {
    let state = reduceClaudeWorkflowMessage({}, background([activeWorkflow('workflow-1'), activeWorkflow('workflow-2')]), 1000).state;
    const notified = reduceClaudeWorkflowMessage(state, system('task_notification', { task_id: 'workflow-1' }), 1100);
    const updated = reduceClaudeWorkflowMessage(notified.state, system('task_updated', { task: { id: 'workflow-2', status: 'failed' } }), 1200);

    expect(notified).toMatchObject({ publication: 'immediate', state: { 'workflow-2': expect.anything() } });
    expect(notified.state['workflow-1']).toBeUndefined();
    expect(updated).toEqual({ state: {}, publication: 'immediate' });
  });

  it('removes active workflows absent from a complete background snapshot', () => {
    const state = reduceClaudeWorkflowMessage({}, background([activeWorkflow()]), 1000).state;
    const result = reduceClaudeWorkflowMessage(state, background([{ task_id: 'shell-1', task_type: 'shell' }]), 1100);

    expect(result).toEqual({ state: {}, publication: 'immediate' });
  });

  it('preserves the state reference for assistant and malformed progress messages', () => {
    const state: ClaudeWorkflowReducerState = reduceClaudeWorkflowMessage({}, background([activeWorkflow()]), 1000).state;
    const assistant = reduceClaudeWorkflowMessage(state, { type: 'assistant', task_id: 'workflow-1' }, 1100);
    const malformed = reduceClaudeWorkflowMessage(state, system('task_progress', { task_id: 42, workflow_progress: [] }), 1100);

    expect(assistant).toEqual({ state, publication: 'none' });
    expect(assistant.state).toBe(state);
    expect(malformed).toEqual({ state, publication: 'none' });
    expect(malformed.state).toBe(state);
  });
});
