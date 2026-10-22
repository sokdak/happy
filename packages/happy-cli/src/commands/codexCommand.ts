import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { runCodex } from '@/codex/runCodex'
import { extractCodexResumeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'
import type { PermissionMode } from '@/api/types'
import type { ReasoningEffort } from '@/codex/codexAppServerTypes'
import { CODEX_EFFORT_LEVELS } from '@/utils/effortLevels'
import packageJson from '../../package.json'

/**
 * `happy codex --help` used to fall straight through the flag loop below and
 * start a real session - authenticating, launching a daemon and creating a
 * server-side session to answer a question about usage. Help is answered
 * before any of that, and mirrors `happy --help` by appending the agent's own.
 */
function printCodexHelp(): void {
  console.log(`
${chalk.bold('happy codex')} - Codex with mobile control

${chalk.bold('Usage:')}
  happy codex [options]

${chalk.bold('Happy options:')}
  --model <name>            Model to run
  --effort <level>          Reasoning effort: ${CODEX_EFFORT_LEVELS.join(', ')}
  --permission-mode <mode>  Codex permission mode
  --yolo                    Shortcut for --permission-mode yolo
  --resume <thread-id>      Attach to an existing Codex thread
  --no-sandbox              Disable the Happy sandbox for this session
  -h, --help                Show this help

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Codex Options (from `codex --help`):')}
`)

  try {
    // execFileSync pipes the child's stderr to ours unless stdio says
    // otherwise, so a missing codex prints a spawn stack trace next to the
    // friendly message below.
    console.log(execFileSync('codex', ['--help'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }))
  } catch {
    console.log(chalk.yellow('Could not retrieve codex help. Make sure codex is installed.'))
  }
}

/**
 * `happy --version` no longer starts a session, but the top level dispatches on
 * the `codex` subcommand before it parses that flag - so `happy codex --version`
 * kept going through auth, the daemon and a real session. Answer it here too.
 */
function printCodexVersion(): void {
  console.log(`happy version: ${packageJson.version}`)

  try {
    process.stdout.write(execFileSync('codex', ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }))
  } catch {
    console.log(chalk.yellow('Could not retrieve codex version. Make sure codex is installed.'))
  }
}

export async function handleCodexCommand(args: string[]): Promise<void> {
  if (args.some((arg) => arg === '-h' || arg === '--help')) {
    printCodexHelp()
    return
  }

  if (args.some((arg) => arg === '-v' || arg === '--version')) {
    printCodexVersion()
    return
  }

  let startedBy: 'daemon' | 'terminal' | undefined = undefined
  let permissionMode: PermissionMode | undefined = undefined
  let model: string | undefined = undefined
  let effort: ReasoningEffort | undefined = undefined
  const sandboxArgs = extractNoSandboxFlag(args)
  const codexArgs = extractCodexResumeFlag(sandboxArgs.args)

  for (let i = 0; i < codexArgs.args.length; i++) {
    if (codexArgs.args[i] === '--started-by') {
      startedBy = codexArgs.args[++i] as 'daemon' | 'terminal'
    } else if (codexArgs.args[i] === '--permission-mode') {
      permissionMode = codexArgs.args[++i] as PermissionMode
    } else if (codexArgs.args[i] === '--model') {
      model = codexArgs.args[++i]
    } else if (codexArgs.args[i] === '--effort') {
      effort = codexArgs.args[++i] as ReasoningEffort
    } else if (codexArgs.args[i] === '--yolo') {
      permissionMode = 'yolo'
    }
  }

  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runCodex({
    credentials,
    startedBy,
    noSandbox: sandboxArgs.noSandbox,
    resumeThreadId: codexArgs.resumeThreadId ?? undefined,
    permissionMode,
    model,
    effort,
  })
}
