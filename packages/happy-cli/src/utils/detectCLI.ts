import { execSync } from 'child_process';
import os from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import { findAgyBin } from '@/agy/constants';
import { applyAgentPolicy } from './agentPolicy';

export interface CLIAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  openclaw: boolean;
  agy: boolean;
  detectedAt: number;
}

/**
 * Detects which CLI tools are available on this machine.
 * Cross-platform: uses `command -v` on POSIX, `Get-Command` on Windows.
 */
export function detectCLIAvailability(env: NodeJS.ProcessEnv = process.env): CLIAvailability {
  const isWindows = os.platform() === 'win32';

  const detected = isWindows ? detectWindows(env) : detectPosix(env);

  // A CLI on PATH is not necessarily one this deployment wants used — an
  // operator can be running Codex-only with an unauthenticated `claude`
  // installed. The policy has the final say on what we advertise.
  return applyAgentPolicy(detected, env);
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command} >/dev/null 2>&1`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function detectPosix(env: NodeJS.ProcessEnv): CLIAvailability {
  const claude = commandExists('claude');
  const codex = commandExists('codex');
  const gemini = commandExists('gemini');
  const agy = findAgyBin() !== undefined;

  // OpenClaw: check command, config file, or env var
  const openclawCommand = commandExists('openclaw');
  const openclawConfig = existsSync(join(os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, agy, detectedAt: Date.now() };
}

function detectWindows(env: NodeJS.ProcessEnv): CLIAvailability {
  const checkCommand = (name: string): boolean => {
    try {
      execSync(`powershell -NoProfile -Command "Get-Command ${name} -ErrorAction SilentlyContinue"`, { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };

  const claude = checkCommand('claude');
  const codex = checkCommand('codex');
  const gemini = checkCommand('gemini');
  const agy = findAgyBin() !== undefined;

  // OpenClaw: check command, config file, or env var
  const openclawCommand = checkCommand('openclaw');
  const openclawConfig = existsSync(join(env.USERPROFILE || os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, agy, detectedAt: Date.now() };
}
