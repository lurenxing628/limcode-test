import * as fs from 'node:fs';
import * as path from 'node:path';

/** PowerShell 7 ships pipeline chain operators and correct `$?` for parenthesized commands. */
const POWERSHELL_CORE_EXECUTABLE = 'pwsh.exe';
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

/**
 * Resolves the Windows shell every spawn path uses: PowerShell 7 when installed, Windows PowerShell
 * 5.1 otherwise. Resolution is a bounded stat sweep rather than a probe spawn, so the detached
 * process Wrapper can resolve per launch without paying for a child process.
 */
export function resolveWindowsPowerShell(): WindowsPowerShellRuntime {
  if (cachedRuntime === undefined) cachedRuntime = locatePowerShellCore() ?? WINDOWS_POWERSHELL_RUNTIME;
  return cachedRuntime;
}

function locatePowerShellCore(): WindowsPowerShellRuntime | undefined {
  if (process.platform !== 'win32') return undefined;
  for (const directory of candidateDirectories()) {
    const candidate = path.join(directory, POWERSHELL_CORE_EXECUTABLE);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (stats.isFile()) return { executable: candidate, edition: 'core' };
  }
  return undefined;
}

function candidateDirectories(): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined): void => {
    if (!value) return;
    // PATH entries may carry surrounding quotes and trailing separators.
    const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    directories.push(trimmed);
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
