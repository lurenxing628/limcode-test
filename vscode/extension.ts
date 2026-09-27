import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { MainPanel } from './panels/MainPanel';
import { registerSidebarEntryView } from './views/SidebarEntryView';
import { ApplicationStartup } from './ApplicationStartup';
import { stopRuntimeDataSetUpgrades } from './runtimeDataSetUpgradeLifetime';
import type { VscodeReliableKernelApplicationFacade } from '../backend/application/reliableKernel/VscodeReliableKernelApplicationFacade';
import { EXTENSION_BRAND } from '../shared/extensionIdentity';

let backendApp: VscodeReliableKernelApplicationFacade | undefined;
let exclusiveMaintenanceParticipant: { dispose(): Promise<void> } | undefined;
let activeStartup: ApplicationStartup | undefined;
let activeContext: vscode.ExtensionContext | undefined;
/** This window's own maintenance request that ended without completing right before it was reloaded. */
const RELOAD_NOTICE_KEY = 'limcode.exclusiveMaintenance.noticeAfterReload';
const RELOAD_NOTICE_TTL_MS = 10 * 60_000;

export function activate(context: vscode.ExtensionContext): void {
  const activationStartedAt = Date.now();
  const startup = new ApplicationStartup();
  activeStartup = startup;
  activeContext = context;

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
    const {
      mergeHistoricalDataSetsInBackground, openWithRuntimeDataSetSelection, upgradeHistoricalDataSetsOnStartup
    } = await import('./commands/runtimeDataSetManagement');
    const dataRootCommands = await import('./commands/dataRootRelocation');
    // Another window may hold the data directory (a migration, a large merge, or it is opening):
    // after a second the shell and a notification say why and for how long; never opens past it.
    const { createRuntimeOpeningWaitPresenter } = await import('./runtimeOpeningWait');
    const openingWait = createRuntimeOpeningWaitPresenter((status) => startup.reportWaiting(status));
    // A window that reloaded for a data-directory move waits on the old directory until the move
    // ends; it says so at once. A move whose process is gone is undone first.
    const waiting = await dataRootCommands.beforeDataRootOpen(context).catch((error) => {
      console.warn(`${EXTENSION_BRAND} data root relocation check failed.`, error);
      return undefined;
    });
    if (waiting) openingWait.announce(`${waiting}；未发送的输入已保留。`);
    let application: Awaited<ReturnType<typeof VscodeReliableKernelApplicationFacade.open>>;
    try {
      application = await openWithRuntimeDataSetSelection(context, () => VscodeReliableKernelApplicationFacade.open(context, {
        onRuntimeWait: (wait) => { if (activeStartup === startup) openingWait.onWait(wait); }
      }));
    } finally {
      openingWait.end();
    }
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
    void dataRootCommands.afterDataRootOpened(context, application.dataRootPath())
      .catch((error) => console.warn(`${EXTENSION_BRAND} data root follow-up failed.`, error));

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
    // Other windows may later ask for a short exclusive window (historical merge); take part.
    void import('./runtimeExclusiveMaintenance').then(
      ({ startExclusiveMaintenanceParticipant }) => {
        if (activeStartup !== startup || backendApp !== application) return;
        exclusiveMaintenanceParticipant = startExclusiveMaintenanceParticipant(application, {
          isCurrent: () => activeStartup === startup && backendApp === application,
          rememberAcrossReload: (text) => context.workspaceState.update(RELOAD_NOTICE_KEY, { text, at: Date.now() })
        });
      },
      (error) => console.warn(`${EXTENSION_BRAND} exclusive maintenance participation failed to start.`, error)
    );
    showNoticeKeptAcrossReload(context);
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
      const isCurrent = () => activeStartup === startup && backendApp === application;
      // Old data sets are upgraded, then merged online into this Runtime, both in the background.
      void upgradeHistoricalDataSetsOnStartup(context, isCurrent)
        .catch(error => console.error(`${EXTENSION_BRAND} historical data upgrade failed.`, error))
        .then(() => mergeHistoricalDataSetsInBackground(context, application, isCurrent))
        .catch(error => console.error(`${EXTENSION_BRAND} historical data merge failed.`, error));
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
    if ((error as { code?: unknown } | null)?.code === 'data-root-unavailable') {
      // Never an empty history in place of an unmounted drive: offer retry or the old directory.
      void import('./commands/dataRootRelocation')
        .then(({ offerDataRootRecovery }) => offerDataRootRecovery(context, startup, `${EXTENSION_BRAND} ${message}`))
        .catch((offerError) => console.error(`${EXTENSION_BRAND} data root recovery prompt failed.`, offerError));
      return;
    }
    void vscode.window.showErrorMessage(`${EXTENSION_BRAND} 运行时无法启动：${message}`);
  }
}

/** This window's own maintenance request ended without completing just before another one reloaded it. */
function showNoticeKeptAcrossReload(context: vscode.ExtensionContext): void {
  const kept = context.workspaceState.get<{ text?: unknown; at?: unknown }>(RELOAD_NOTICE_KEY);
  if (!kept) return;
  void context.workspaceState.update(RELOAD_NOTICE_KEY, undefined);
  if (typeof kept.text !== 'string' || typeof kept.at !== 'number' || Date.now() - kept.at > RELOAD_NOTICE_TTL_MS) return;
  void vscode.window.showWarningMessage(`${EXTENSION_BRAND} 重载前：${kept.text}`);
}

export async function deactivate(): Promise<void> {
  const startup = activeStartup;
  activeStartup = undefined;
  const app = backendApp;
  backendApp = undefined;
  const context = activeContext;
  activeContext = undefined;
  const participant = exclusiveMaintenanceParticipant;
  exclusiveMaintenanceParticipant = undefined;
  const participation = participant ? participant.dispose().catch(() => undefined) : Promise.resolve();
  // Stop the current application's work immediately while any in-flight historical upgrade
  // finishes its durable boundary, including history commands used without a running Runtime.
  const upgrades = context ? stopRuntimeDataSetUpgrades(context) : Promise.resolve();
  const pending = startup?.pending();
  const disposal = app ? app.dispose() : pending?.then(application => application.dispose(), () => undefined);
  const [disposed] = await Promise.allSettled([disposal, upgrades, participation]);
  if (disposed.status === 'rejected') throw disposed.reason;
}
