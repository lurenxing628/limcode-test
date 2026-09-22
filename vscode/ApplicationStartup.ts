import type { ApplicationFacade } from './ApplicationFacade';

/**
 * Lightweight activation barrier shared by VS Code surfaces.
 *
 * The extension entrypoint creates this object before loading the reliable Runtime module. Views,
 * serializers and commands can therefore register during activation without pulling the complete
 * backend require graph onto the Extension Host's synchronous startup path.
 */
export class ApplicationStartup {
  private readonly ready: Promise<ApplicationFacade>;
  private resolveReady!: (application: ApplicationFacade) => void;
  private rejectReady!: (error: unknown) => void;
  private starter: (() => void) | undefined;
  private startRequested = false;
  private started = false;
  private settled = false;
  private application: ApplicationFacade | undefined;

  public constructor() {
    this.ready = new Promise<ApplicationFacade>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Surfaces attach their own error handling when they need the Runtime. Keep a background
    // startup failure observed even when activation came from a command/view that was then closed.
    void this.ready.catch(() => undefined);
  }

  public setStarter(starter: () => void): void {
    if (this.starter || this.started) throw new Error('Application startup handler is already registered.');
    this.starter = starter;
    this.tryStart();
  }

  public wait(): Promise<ApplicationFacade> {
    this.startRequested = true;
    this.tryStart();
    return this.ready;
  }

  /** Returns an already-requested startup without turning deactivation into a new activation. */
  public pending(): Promise<ApplicationFacade> | undefined {
    return this.startRequested ? this.ready : undefined;
  }

  /** Maintenance commands can work even when normal Runtime startup has not completed. */
  public current(): ApplicationFacade | undefined { return this.application; }

  public resolve(application: ApplicationFacade): void {
    if (this.settled) return;
    this.settled = true;
    this.application = application;
    this.resolveReady(application);
  }

  public reject(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectReady(error);
  }

  private tryStart(): void {
    if (!this.startRequested || this.started || !this.starter) return;
    this.started = true;
    try {
      this.starter();
    } catch (error) {
      this.reject(error);
    }
  }
}
