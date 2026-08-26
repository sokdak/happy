import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAuthAndSetupMachineIfNeeded: vi.fn(),
  mockRunCodex: vi.fn(),
  mockExtractCodexResumeFlag: vi.fn(),
  mockExtractNoSandboxFlag: vi.fn(),
  mockEnsureDaemonRunning: vi.fn(),
  mockExecFileSync: vi.fn(),
}))

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: mocks.mockAuthAndSetupMachineIfNeeded,
}))

vi.mock('@/codex/runCodex', () => ({
  runCodex: mocks.mockRunCodex,
}))

vi.mock('@/codex/cliArgs', () => ({
  extractCodexResumeFlag: mocks.mockExtractCodexResumeFlag,
}))

vi.mock('@/utils/sandboxFlags', () => ({
  extractNoSandboxFlag: mocks.mockExtractNoSandboxFlag,
}))

vi.mock('@/daemon/ensureDaemonRunning', () => ({
  ensureDaemonRunning: mocks.mockEnsureDaemonRunning,
}))

vi.mock('node:child_process', () => ({
  execFileSync: mocks.mockExecFileSync,
}))

import { handleCodexCommand } from './codexCommand'

describe('handleCodexCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockAuthAndSetupMachineIfNeeded.mockResolvedValue({
      credentials: { token: 'token' },
    })
    mocks.mockExtractNoSandboxFlag.mockImplementation((args: string[]) => ({
      noSandbox: false,
      args,
    }))
    mocks.mockExtractCodexResumeFlag.mockImplementation((args: string[]) => ({
      resumeThreadId: null,
      args,
    }))
    mocks.mockEnsureDaemonRunning.mockResolvedValue(undefined)
    mocks.mockRunCodex.mockResolvedValue(undefined)
    mocks.mockExecFileSync.mockReturnValue('codex-cli 0.149.1\n')
  })

  it('ensures the daemon is running before starting a codex session', async () => {
    await handleCodexCommand(['--started-by', 'terminal'])

    expect(mocks.mockEnsureDaemonRunning).toHaveBeenCalledTimes(1)
    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: 'terminal',
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: undefined,
      model: undefined,
      effort: undefined,
    })
    expect(
      mocks.mockEnsureDaemonRunning.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.mockRunCodex.mock.invocationCallOrder[0])
  })

  it('passes parsed no-sandbox and resume flags through to runCodex', async () => {
    mocks.mockExtractNoSandboxFlag.mockReturnValue({
      noSandbox: true,
      args: ['--resume', 'thread-123', '--started-by', 'daemon'],
    })
    mocks.mockExtractCodexResumeFlag.mockReturnValue({
      resumeThreadId: 'thread-123',
      args: ['--started-by', 'daemon'],
    })

    await handleCodexCommand(['--no-sandbox', '--resume', 'thread-123', '--started-by', 'daemon'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: 'daemon',
      noSandbox: true,
      resumeThreadId: 'thread-123',
      permissionMode: undefined,
      model: undefined,
      effort: undefined,
    })
  })

  it('passes permission-mode through to runCodex', async () => {
    await handleCodexCommand(['--permission-mode', 'yolo'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: undefined,
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: 'yolo',
      model: undefined,
      effort: undefined,
    })
  })

  it('maps --yolo to codex yolo permission mode', async () => {
    await handleCodexCommand(['--yolo'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: undefined,
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: 'yolo',
      model: undefined,
      effort: undefined,
    })
  })

  it('passes model and effort through to runCodex', async () => {
    await handleCodexCommand(['--model', 'gpt-5.4', '--effort', 'xhigh'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: undefined,
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: undefined,
      model: 'gpt-5.4',
      effort: 'xhigh',
    })
  })

  describe('--help', () => {
    // `happy codex --help` used to fall through the flag loop untouched and
    // start a real session: authenticating, launching a daemon and creating a
    // server-side session, all to answer a question about usage.
    for (const flag of ['--help', '-h']) {
      it(`prints usage and starts nothing for ${flag}`, async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => { })

        await handleCodexCommand([flag])

        expect(mocks.mockAuthAndSetupMachineIfNeeded).not.toHaveBeenCalled()
        expect(mocks.mockEnsureDaemonRunning).not.toHaveBeenCalled()
        expect(mocks.mockRunCodex).not.toHaveBeenCalled()
        expect(log).toHaveBeenCalled()

        log.mockRestore()
      })
    }

    it('recognises the flag after other arguments', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => { })

      await handleCodexCommand(['--model', 'gpt-5.5', '--help'])

      expect(mocks.mockRunCodex).not.toHaveBeenCalled()

      log.mockRestore()
    })

    it('appends codex own help', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => { })

      await handleCodexCommand(['--help'])

      expect(mocks.mockExecFileSync).toHaveBeenCalledWith(
        'codex',
        ['--help'],
        // Not inheriting stderr: otherwise a missing codex prints a spawn
        // stack trace right under the "codex is not installed" message.
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
      )

      log.mockRestore()
    })

    it('still prints happy usage when codex is not installed', async () => {
      mocks.mockExecFileSync.mockImplementation(() => {
        throw new Error('spawn codex ENOENT')
      })
      const log = vi.spyOn(console, 'log').mockImplementation(() => { })

      await expect(handleCodexCommand(['--help'])).resolves.toBeUndefined()
      expect(log).toHaveBeenCalled()

      log.mockRestore()
    })
  })

  describe('--version', () => {
    // `happy --version` was fixed to stop starting a session, but the top level
    // dispatches on the `codex` subcommand before it ever parses --version, so
    // `happy codex --version` still went all the way through auth, daemon and
    // runCodex.
    for (const flag of ['--version', '-v']) {
      it(`prints versions and starts nothing for ${flag}`, async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => { })
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

        await handleCodexCommand([flag])

        expect(mocks.mockAuthAndSetupMachineIfNeeded).not.toHaveBeenCalled()
        expect(mocks.mockEnsureDaemonRunning).not.toHaveBeenCalled()
        expect(mocks.mockRunCodex).not.toHaveBeenCalled()
        expect(mocks.mockExecFileSync).toHaveBeenCalledWith(
          'codex',
          ['--version'],
          expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
        )

        stdout.mockRestore()
        log.mockRestore()
      })
    }

    it('still reports happy own version when codex is not installed', async () => {
      mocks.mockExecFileSync.mockImplementation(() => {
        throw new Error('spawn codex ENOENT')
      })
      const log = vi.spyOn(console, 'log').mockImplementation(() => { })

      await expect(handleCodexCommand(['--version'])).resolves.toBeUndefined()
      expect(log).toHaveBeenCalled()
      expect(mocks.mockRunCodex).not.toHaveBeenCalled()

      log.mockRestore()
    })

    it('prefers help when both flags are present', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => { })

      await handleCodexCommand(['--version', '--help'])

      expect(mocks.mockExecFileSync).toHaveBeenCalledWith('codex', ['--help'], expect.anything())
      expect(mocks.mockRunCodex).not.toHaveBeenCalled()

      log.mockRestore()
    })
  })

  it('does not advertise an effort level codex cannot run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { })

    await handleCodexCommand(['--help'])
    const helpText = log.mock.calls.map((call) => String(call[0])).join('\n')

    expect(helpText).not.toMatch(/\bmax\b/)
    expect(helpText).toContain('minimal')

    log.mockRestore()
  })
})
