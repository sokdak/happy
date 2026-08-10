import type {
  ActiveWorkflowAgentSnapshot,
  ActiveWorkflowPhaseSnapshot,
  ActiveWorkflowSnapshot,
} from '@/api/types'

export type ClaudeWorkflowReducerState = Record<string, ActiveWorkflowSnapshot>
export type ClaudeWorkflowPublication = 'none' | 'progress' | 'immediate'
export type ClaudeWorkflowReducerResult = {
  state: ClaudeWorkflowReducerState
  publication: ClaudeWorkflowPublication
}

type RecordValue = Record<string, unknown>

const terminalStatuses = new Set([
  'completed',
  'done',
  'success',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'killed',
])

function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function exactString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringField(record: RecordValue | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(record?.[key])
    if (value !== undefined) return value
  }
  return undefined
}

function numberField(record: RecordValue | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(record?.[key])
    if (value !== undefined) return value
  }
  return undefined
}

function taskIdFor(message: RecordValue): string | undefined {
  return stringField(message, 'task_id')
    ?? stringField(asRecord(message.task), 'task_id', 'id')
}

function taskStatusFor(message: RecordValue): string | undefined {
  return stringField(message, 'status')
    ?? stringField(asRecord(message.task), 'status')
    ?? stringField(asRecord(message.update), 'status')
    ?? stringField(asRecord(message.patch), 'status')
}

function taskTypeFor(message: RecordValue): string | undefined {
  return exactString(message.task_type) ?? exactString(asRecord(message.task)?.task_type)
}

function workflowNameFor(message: RecordValue): string | undefined {
  return stringField(message, 'workflow_name') ?? stringField(asRecord(message.task), 'workflow_name')
}

function descriptionFor(message: RecordValue): string | undefined {
  return stringField(message, 'description') ?? stringField(asRecord(message.task), 'description')
}

function optionalString(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = nonEmptyString(value)
  if (parsed !== undefined) target[key] = parsed
}

function optionalNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = finiteNumber(value)
  if (parsed !== undefined) target[key] = parsed
}

function parseAgent(value: unknown): { agent: ActiveWorkflowAgentSnapshot; phaseIndex: number; phaseTitle?: string } | undefined {
  const entry = asRecord(value)
  if (!entry || entry.type !== 'workflow_agent') return undefined

  const id = stringField(entry, 'agentId')
  const index = numberField(entry, 'index')
  const label = stringField(entry, 'label')
  const phaseIndex = numberField(entry, 'phaseIndex')
  const state = stringField(entry, 'state')
  if (!id || index === undefined || !label || phaseIndex === undefined || !state) return undefined

  const agent: ActiveWorkflowAgentSnapshot = { id, index, label, state }
  const optional = agent as unknown as Record<string, unknown>
  optionalString(optional, 'model', entry.model)
  optionalNumber(optional, 'queuedAt', entry.queuedAt)
  optionalNumber(optional, 'startedAt', entry.startedAt)
  optionalString(optional, 'lastToolName', entry.lastToolName)
  optionalString(optional, 'lastToolSummary', entry.lastToolSummary)
  optionalNumber(optional, 'lastProgressAt', entry.lastProgressAt)
  optionalNumber(optional, 'tokens', entry.tokens)
  optionalNumber(optional, 'toolCalls', entry.toolCalls)
  optionalNumber(optional, 'durationMs', entry.durationMs)

  return { agent, phaseIndex, phaseTitle: stringField(entry, 'phaseTitle') }
}

function parseHierarchy(value: unknown): ActiveWorkflowPhaseSnapshot[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined

  const phaseTitles = new Map<number, string>()
  const agents: Array<{ agent: ActiveWorkflowAgentSnapshot; phaseIndex: number; phaseTitle?: string }> = []

  for (const valueEntry of value) {
    const entry = asRecord(valueEntry)
    if (!entry) continue
    if (entry.type === 'workflow_phase') {
      const index = numberField(entry, 'index')
      const title = stringField(entry, 'title')
      if (index !== undefined && title) phaseTitles.set(index, title)
      continue
    }

    const agent = parseAgent(entry)
    if (agent) agents.push(agent)
  }

  for (const { phaseIndex, phaseTitle } of agents) {
    if (!phaseTitles.has(phaseIndex) && phaseTitle) phaseTitles.set(phaseIndex, phaseTitle)
  }

  if (phaseTitles.size === 0 && agents.length === 0) return undefined

  const agentsByPhase = new Map<number, ActiveWorkflowAgentSnapshot[]>()
  const otherAgents: ActiveWorkflowAgentSnapshot[] = []
  for (const { agent, phaseIndex } of agents) {
    if (!phaseTitles.has(phaseIndex)) {
      otherAgents.push(agent)
      continue
    }
    const phaseAgents = agentsByPhase.get(phaseIndex) ?? []
    phaseAgents.push(agent)
    agentsByPhase.set(phaseIndex, phaseAgents)
  }

  const sortAgents = (left: ActiveWorkflowAgentSnapshot, right: ActiveWorkflowAgentSnapshot) =>
    left.index - right.index || left.id.localeCompare(right.id)
  const phases = [...phaseTitles.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, title]) => ({ index, title, agents: (agentsByPhase.get(index) ?? []).sort(sortAgents) }))

  if (otherAgents.length > 0) {
    phases.push({ index: -1, title: 'Other', agents: otherAgents.sort(sortAgents) })
  }
  return phases
}

function workflowProgressFor(message: RecordValue): unknown {
  if (message.workflow_progress !== undefined) return message.workflow_progress
  return asRecord(message.progress)?.workflow_progress
}

function usageFor(message: RecordValue, previous?: ActiveWorkflowSnapshot['usage']): ActiveWorkflowSnapshot['usage'] | undefined {
  const nested = asRecord(message.usage)
  const totalTokens = numberField(nested, 'total_tokens', 'totalTokens') ?? numberField(message, 'total_tokens', 'totalTokens') ?? previous?.totalTokens
  const toolUses = numberField(nested, 'tool_uses', 'tool_calls', 'toolUses') ?? numberField(message, 'tool_uses', 'tool_calls', 'toolUses') ?? previous?.toolUses
  const durationMs = numberField(nested, 'duration_ms', 'durationMs') ?? numberField(message, 'duration_ms', 'durationMs') ?? previous?.durationMs
  return totalTokens === undefined && toolUses === undefined && durationMs === undefined
    ? undefined
    : { totalTokens, toolUses, durationMs }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameWorkflowState(left: ClaudeWorkflowReducerState, right: ClaudeWorkflowReducerState): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && same(left[key], right[key]))
}

function unchanged(state: ClaudeWorkflowReducerState): ClaudeWorkflowReducerResult {
  return { state, publication: 'none' }
}

function workflowFor(state: ClaudeWorkflowReducerState, taskId: string): ActiveWorkflowSnapshot | undefined {
  return Object.hasOwn(state, taskId) ? state[taskId] : undefined
}

function withWorkflow(
  state: ClaudeWorkflowReducerState,
  taskId: string,
  workflow: ActiveWorkflowSnapshot,
): ClaudeWorkflowReducerState {
  return Object.fromEntries([
    ...Object.entries(state).filter(([id]) => id !== taskId),
    [taskId, workflow],
  ])
}

function withoutWorkflow(state: ClaudeWorkflowReducerState, taskId: string): ClaudeWorkflowReducerState {
  return Object.fromEntries(Object.entries(state).filter(([id]) => id !== taskId))
}

function reduceBackground(state: ClaudeWorkflowReducerState, message: RecordValue, now: number): ClaudeWorkflowReducerResult {
  const rawTasks = Array.isArray(message.background_tasks) ? message.background_tasks
    : Array.isArray(message.tasks) ? message.tasks
      : undefined
  if (!rawTasks) return unchanged(state)

  const entries: Array<[string, ActiveWorkflowSnapshot]> = []
  for (const rawTask of rawTasks) {
    const task = asRecord(rawTask)
    if (!task || taskTypeFor(task) !== 'local_workflow') continue
    const taskId = stringField(task, 'task_id', 'id')
    if (!taskId) continue
    const existing = workflowFor(state, taskId)
    entries.push([taskId, existing ?? {
      taskId,
      name: workflowNameFor(task) ?? descriptionFor(task) ?? 'Workflow',
      ...(descriptionFor(task) ? { description: descriptionFor(task) } : {}),
      startedAt: now,
      updatedAt: now,
      phases: [],
    }])
  }
  const next = Object.fromEntries(entries) as ClaudeWorkflowReducerState
  return sameWorkflowState(next, state) ? unchanged(state) : { state: next, publication: 'immediate' }
}

function reduceStarted(state: ClaudeWorkflowReducerState, message: RecordValue, now: number): ClaudeWorkflowReducerResult {
  if (taskTypeFor(message) !== 'local_workflow') return unchanged(state)
  const taskId = taskIdFor(message)
  if (!taskId) return unchanged(state)

  const previous = workflowFor(state, taskId)
  const name = workflowNameFor(message) ?? descriptionFor(message) ?? previous?.name ?? 'Workflow'
  const description = descriptionFor(message) ?? previous?.description
  const nextWorkflow: ActiveWorkflowSnapshot = {
    taskId,
    ...(stringField(message, 'tool_use_id') ? { toolUseId: stringField(message, 'tool_use_id') } : previous?.toolUseId ? { toolUseId: previous.toolUseId } : {}),
    name,
    ...(description ? { description } : {}),
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    ...(previous?.usage ? { usage: previous.usage } : {}),
    phases: previous?.phases ?? [],
  }
  if (previous && same(nextWorkflow, previous)) return unchanged(state)
  return { state: withWorkflow(state, taskId, nextWorkflow), publication: 'immediate' }
}

function reduceProgress(state: ClaudeWorkflowReducerState, message: RecordValue, now: number): ClaudeWorkflowReducerResult {
  const taskId = taskIdFor(message)
  const previous = taskId ? workflowFor(state, taskId) : undefined
  if (!taskId || !previous) return unchanged(state)

  const progress = asRecord(message.progress)
  const description = stringField(message, 'summary') ?? stringField(message, 'description') ?? stringField(progress, 'summary') ?? stringField(progress, 'description') ?? previous.description
  const phases = parseHierarchy(workflowProgressFor(message)) ?? previous.phases
  const usage = usageFor(message, previous.usage)
  const nextWorkflow: ActiveWorkflowSnapshot = {
    ...previous,
    ...(description ? { description } : {}),
    updatedAt: now,
    ...(usage ? { usage } : {}),
    phases,
  }
  if (same(nextWorkflow, previous)) return unchanged(state)
  return { state: withWorkflow(state, taskId, nextWorkflow), publication: 'progress' }
}

function removeWorkflow(state: ClaudeWorkflowReducerState, taskId: string): ClaudeWorkflowReducerResult {
  if (!workflowFor(state, taskId)) return unchanged(state)
  return { state: withoutWorkflow(state, taskId), publication: 'immediate' }
}

export function reduceClaudeWorkflowMessage(
  state: ClaudeWorkflowReducerState,
  rawMessage: unknown,
  now = Date.now(),
): ClaudeWorkflowReducerResult {
  const message = asRecord(rawMessage)
  if (!message || message.type !== 'system') return unchanged(state)

  const subtype = exactString(message.subtype)
  if (subtype === 'background_tasks_changed') return reduceBackground(state, message, now)
  if (subtype === 'task_started') return reduceStarted(state, message, now)
  if (subtype === 'task_progress') return reduceProgress(state, message, now)
  if (subtype === 'task_notification') {
    const taskId = taskIdFor(message)
    return taskId ? removeWorkflow(state, taskId) : unchanged(state)
  }
  if (subtype === 'task_updated') {
    const taskId = taskIdFor(message)
    const status = taskStatusFor(message)?.toLowerCase()
    return taskId && status && terminalStatuses.has(status) ? removeWorkflow(state, taskId) : unchanged(state)
  }
  return unchanged(state)
}

export class ClaudeWorkflowTracker {
  private state: ClaudeWorkflowReducerState = {}
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly pendingPublications = new Map<Promise<void>, AbortController>()
  private publicationErrors: unknown[] = []
  private sealed = false
  private disposed = false
  private readonly now: () => number
  private readonly coalesceMs: number

  constructor(
    private readonly publish: (snapshot: ClaudeWorkflowReducerState, signal: AbortSignal) => void | Promise<void>,
    options: { now?: () => number; coalesceMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now
    this.coalesceMs = options.coalesceMs ?? 250
  }

  handle(message: unknown): void {
    if (this.sealed || this.disposed) return
    const result = reduceClaudeWorkflowMessage(this.state, message, this.now())
    if (result.publication === 'none') return

    this.state = result.state
    if (result.publication === 'immediate') {
      this.cancelPending()
      this.publishCurrent()
      return
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.publishCurrent()
      }, this.coalesceMs)
    }
  }

  async reset(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('Claude workflow tracker is disposed')
    this.cancelPending()
    this.state = {}
    const abortAll = () => this.abortPublications(signal?.reason)
    signal?.addEventListener('abort', abortAll, { once: true })
    try {
      await this.publishCurrent(signal)
      // A successful authoritative empty publication supersedes any earlier
      // publication failure that could have left remote state stale.
      this.publicationErrors = []
    } finally {
      signal?.removeEventListener('abort', abortAll)
    }
  }

  seal(): void {
    if (this.sealed) return
    this.sealed = true
    this.cancelPending()
  }

  dispose(): void {
    if (this.disposed) return
    this.seal()
    this.disposed = true
    this.abortPublications(new Error('Claude workflow tracker disposed'))
  }

  async drain(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    const drainController = new AbortController()
    const forwardAbort = () => drainController.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeout = options.timeoutMs === undefined
      ? null
      : setTimeout(() => {
        drainController.abort(new Error(`Claude workflow drain timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)
    const abortPending = () => this.abortPublications(drainController.signal.reason)
    drainController.signal.addEventListener('abort', abortPending, { once: true })

    try {
      if (options.signal?.aborted) forwardAbort()
      while (this.pendingPublications.size > 0) {
        await Promise.allSettled([...this.pendingPublications.keys()])
      }
      if (drainController.signal.aborted) {
        throw drainController.signal.reason ?? new Error('Claude workflow drain aborted')
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', forwardAbort)
      drainController.signal.removeEventListener('abort', abortPending)
    }

    const errors = this.publicationErrors.splice(0)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Claude workflow publications failed')
  }

  snapshot(): ClaudeWorkflowReducerState {
    return this.state
  }

  private publishCurrent(signal?: AbortSignal): Promise<void> {
    // Object.fromEntries preserves reserved task ids such as "__proto__" as
    // own data properties, unlike assigning those ids onto a normal object.
    const snapshot = Object.fromEntries(Object.entries(this.state)) as ClaudeWorkflowReducerState
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort, { once: true })
    if (signal?.aborted) forwardAbort()

    let rawPublication: Promise<void>
    try {
      rawPublication = Promise.resolve(this.publish(snapshot, controller.signal))
    } catch (error) {
      rawPublication = Promise.reject(error)
    }

    const publication = new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (handler: () => void) => {
        if (settled) return
        settled = true
        controller.signal.removeEventListener('abort', onAbort)
        handler()
      }
      const onAbort = () => settle(() => reject(
        controller.signal.reason ?? new Error('Claude workflow publication aborted'),
      ))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
      void rawPublication.then(
        () => settle(resolve),
        (error) => settle(() => reject(error)),
      )
    })

    this.pendingPublications.set(publication, controller)
    void publication.then(
      () => {
        this.pendingPublications.delete(publication)
        signal?.removeEventListener('abort', forwardAbort)
      },
      (error) => {
        this.pendingPublications.delete(publication)
        signal?.removeEventListener('abort', forwardAbort)
        if (!controller.signal.aborted) this.publicationErrors.push(error)
      },
    )
    return publication
  }

  private abortPublications(reason?: unknown): void {
    for (const controller of this.pendingPublications.values()) {
      if (!controller.signal.aborted) controller.abort(reason)
    }
  }

  private cancelPending(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
