import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** PowerShell 7 ships pipeline chain operators and correct `$?` for parenthesized commands. */
const POWERSHELL_CORE_EXECUTABLE = 'pwsh.exe';
/** Pipeline chain operators and the parenthesized-command `$?` fix require PowerShell 7 or newer. */
const POWERSHELL_CORE_MINIMUM_MAJOR_VERSION = 7;
/** Bound each candidate probe; the selected runtime is cached for this process. */
const POWERSHELL_VERSION_PROBE_TIMEOUT_MS = 5_000;
/** Windows PowerShell 5.1 is present on every supported Windows host and needs no resolution. */
const WINDOWS_POWERSHELL_EXECUTABLE = 'powershell.exe';

export interface WindowsPowerShellRuntime {
  /** Absolute path when PowerShell 7 was located; otherwise the Windows PowerShell command name. */
  readonly executable: string;
  /** `core` is PowerShell 7+, `desktop` is the Windows PowerShell 5.1 fallback. */
  readonly edition: 'core' | 'desktop';
}

const WINDOWS_POWERSHELL_RUNTIME: WindowsPowerShellRuntime = {
  executable: WINDOWS_POWERSHELL_EXECUTABLE,
  edition: 'desktop'
};

let cachedRuntime: WindowsPowerShellRuntime | undefined;

/** Resolve one verified shell per process, independent of later command working directories. */
export function resolveWindowsPowerShell(): WindowsPowerShellRuntime {
  if (cachedRuntime === undefined) cachedRuntime = locatePowerShellCore() ?? WINDOWS_POWERSHELL_RUNTIME;
  return cachedRuntime;
}

function locatePowerShellCore(): WindowsPowerShellRuntime | undefined {
  if (process.platform !== 'win32') return undefined;
  for (const directory of candidateDirectories()) {
    // PATH entries may be relative; resolve against this process's cwd before stat and cache so the
    // returned executable keeps its identity when the Wrapper spawns it with the request's cwd.
    const candidate = path.join(directory, POWERSHELL_CORE_EXECUTABLE);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (stats.isFile() && isVerifiedPowerShellCore(candidate)) {
      return { executable: candidate, edition: 'core' };
    }
  }
  return undefined;
}

/** A file named pwsh.exe is insufficient: PowerShell 6 lacks the required command semantics. */
function isVerifiedPowerShellCore(candidate: string): boolean {
  try {
    const result = spawnSync(candidate, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::Out.Write($PSVersionTable.PSVersion.Major)'
    ], {
      encoding: 'utf8',
      timeout: POWERSHELL_VERSION_PROBE_TIMEOUT_MS,
      maxBuffer: 1024,
      windowsHide: true
    });
    if (result.error || result.status !== 0) return false;
    const major = Number(result.stdout.trim());
    return Number.isInteger(major) && major >= POWERSHELL_CORE_MINIMUM_MAJOR_VERSION;
  } catch {
    return false;
  }
}

function candidateDirectories(): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined): void => {
    if (!value) return;
    // PATH entries may carry surrounding quotes and trailing separators.
    const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed) return;
    const absolute = path.resolve(trimmed);
    const key = absolute.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    directories.push(absolute);
  };
  // Canonical installs come first: a stripped PATH must not silently downgrade the shell, and a real
  // install is preferred over a Microsoft Store execution alias that shadows it on PATH.
  for (const root of [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (root) push(path.join(root, 'PowerShell', '7'));
  }
  for (const entry of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) push(entry);
  return directories;
}

/**
 * Command-syntax guidance handed to the model. Pipeline chain operators only exist on PowerShell 7,
 * so advertising them on a 5.1 fallback host would make every chained command a parse error.
 */
export function powerShellCommandSyntaxGuidance(edition: WindowsPowerShellRuntime['edition']): string {
  return edition === 'core'
    ? 'chain multiple commands with && or ||, or separate them with semicolons; quote paths that contain spaces; for long output, prefer piping to Select-Object -First N. PowerShell has no backslash escape, so a bash-style \\" is a syntax error; to run an inline script, pipe a single-quoted here-string to the interpreter instead of using -e: put @\' alone on the first line, the script verbatim (nothing inside it is escaped or expanded), then \'@ | node - starting at column 0 of the last line; the same works for python -.'
    : 'separate multiple commands with semicolons, because Windows PowerShell 5.1 has no pipeline chain operators; quote paths that contain spaces; for long output, prefer piping to Select-Object -First N. PowerShell has no backslash escape, so a bash-style \\" is a syntax error; to run an inline script, pipe a single-quoted here-string to the interpreter instead of using -e: put @\' alone on the first line, the script verbatim (nothing inside it is escaped or expanded), then \'@ | node - starting at column 0 of the last line; the same works for python -.';
}
