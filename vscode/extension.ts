import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { MainPanel } from './panels/MainPanel';
import { registerSidebarEntryView } from './views/SidebarEntryView';
import { ApplicationStartup } from './ApplicationStartup';
import type { VscodeReliableKernelApplicationFacade } from '../backend/application/reliableKernel/VscodeReliableKernelApplicationFacade';
import { EXTENSION_BRAND } from '../shared/extensionIdentity';

let backendApp: VscodeReliableKernelApplicationFacade | undefined;
let activeStartup: ApplicationStartup | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const activationStartedAt = Date.now();
  const startup = new ApplicationStartup();
  activeStartup = startup;

  // Register every VS Code-owned surface before loading the reliable Runtime graph. In particular,
  // onView activation can now resolve the sidebar and paint its lightweight shell immediately.
  MainPanel.registerSerializer(context, startup);
  registerCommands(context, startup);
  registerSidebarEntryView(context, startup);
  console.log(`${EXTENSION_BRAND} visible surfaces registered in ${Date.now() - activationStartedAt}ms.`);

  // Runtime evaluation is demand-started by the first command or Webview handshake. A sidebar
  // activation therefore gets to fetch and mount its small bundle before CommonJS evaluates the
  // much larger backend graph; no timing-based delay is involved.
  startup.setStarter(() => {
    if (activeStartup === startup) void startApplication(context, startup, activationStartedAt);
  });
}

async function startApplication(
  context: vscode.ExtensionContext,
  startup: ApplicationStartup,
  activationStartedAt: number
): Promise<void> {
  try {
    const moduleStartedAt = Date.now();
    const { VscodeReliableKernelApplicationFacade } = await import(
      '../backend/application/reliableKernel/VscodeReliableKernelApplicationFacade'
    );
    const moduleLoadedAt = Date.now();
    const { openWithRuntimeDataSetSelection } = await import('./commands/runtimeDataSetManagement');
    const application = await openWithRuntimeDataSetSelection(context, () => VscodeReliableKernelApplicationFacade.open(context));
    const applicationOpenedAt = Date.now();

    // Deactivation may race a slow filesystem/SQLite open. Publish the result so deactivate() can
    // close it, but never attach late watchers or recovery work to an obsolete activation.
    if (activeStartup !== startup) {
      startup.resolve(application);
      await application.dispose();
      return;
    }

    backendApp = application;
    startup.resolve(application);

    console.log(
      `${EXTENSION_BRAND} reliable SQLite/CAS Runtime is active `
      + `(module ${moduleLoadedAt - moduleStartedAt}ms, open ${applicationOpenedAt - moduleLoadedAt}ms, `
      + `total ${applicationOpenedAt - activationStartedAt}ms).`
    );

    // These modules are not needed to paint or handshake with a Webview. Load them only after the
    // Runtime barrier opens so they cannot extend the synchronous activation path.
    void import('./watchers/GlobalSettingsWatcher').then(
      ({ registerGlobalSettingsWatcher }) => {
        if (activeStartup === startup && backendApp === application) {
          registerGlobalSettingsWatcher(context, application);
        }
      },
      (error) => console.error(`${EXTENSION_BRAND} settings watcher failed to load.`, error)
    );
    void import('../backend/application/runtimeBuildInfo').then(
      ({ RUNTIME_BUILD_INFO }) => console.log(
        `${EXTENSION_BRAND} Runtime build information.`,
        JSON.stringify(RUNTIME_BUILD_INFO)
      ),
      (error) => console.warn(`${EXTENSION_BRAND} Runtime build information is unavailable.`, error)
    );

    // Promise continuations already waiting on ApplicationStartup (sidebar state or a restored
    // panel) run before this next-turn recovery kickoff and therefore enqueue their bounded visible
    // reads ahead of background scans on the single SQLite worker.
    setImmediate(() => {
      if (activeStartup !== startup || backendApp !== application) return;
      const recoveryStartedAt = Date.now();
      void application.startRuntimeRecovery().then(
        () => console.log(`${EXTENSION_BRAND} reliable Runtime recovery converged in ${Date.now() - recoveryStartedAt}ms.`),
        (error) => {
          if (error instanceof Error && error.name === 'AbortError') return;
          console.error(`${EXTENSION_BRAND} reliable Runtime recovery failed.`, error);
          const message = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`${EXTENSION_BRAND} 运行数据恢复失败：${message}`);
        }
      );
    });
  } catch (error) {
    startup.reject(error);
    if (activeStartup !== startup) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${EXTENSION_BRAND} reliable Runtime failed to open.`, error);
    void vscode.window.showErrorMessage(`${EXTENSION_BRAND} 运行时无法启动：${message}`);
  }
}

export async function deactivate(): Promise<void> {
  const startup = activeStartup;
  activeStartup = undefined;
  const app = backendApp;
  backendApp = undefined;
  if (app) {
    await app.dispose();
    return;
  }
  if (!startup) return;
  const pending = startup.pending();
  if (!pending) return;
  try {
    await (await pending).dispose();
  } catch {
    // Failed startup has no live application to close.
  }
}
