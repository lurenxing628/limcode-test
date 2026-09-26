import type { ExtensionContext } from 'vscode';

interface RuntimeDataSetUpgradeLifetime {
  stopped: boolean;
  operations: Set<Promise<unknown>>;
  stopping?: Promise<void>;
}

const lifetimes = new WeakMap<ExtensionContext, RuntimeDataSetUpgradeLifetime>();

function lifetimeFor(context: ExtensionContext): RuntimeDataSetUpgradeLifetime {
  let lifetime = lifetimes.get(context);
  if (!lifetime) {
    lifetime = { stopped: false, operations: new Set() };
    lifetimes.set(context, lifetime);
  }
  return lifetime;
}

function stoppedError(): Error {
  return Object.assign(new Error('Extension shutdown has stopped admitting Runtime data-set upgrades.'), {
    code: 'runtime-dataset-upgrades-stopped'
  });
}

export function canStartRuntimeDataSetUpgrade(context: ExtensionContext): boolean {
  return lifetimes.get(context)?.stopped !== true;
}

/** Register before invoking the operation, so deactivation cannot miss newly admitted work. */
export function runRuntimeDataSetUpgrade<T>(
  context: ExtensionContext,
  operation: () => Promise<T>
): Promise<T> {
  const lifetime = lifetimeFor(context);
  if (lifetime.stopped) return Promise.reject(stoppedError());
  const running = Promise.resolve().then(() => {
    if (lifetime.stopped) throw stoppedError();
    return operation();
  });
  lifetime.operations.add(running);
  void running.then(
    () => { lifetime.operations.delete(running); },
    () => { lifetime.operations.delete(running); }
  );
  return running;
}

/** Close admission immediately, then wait for every already-started durable operation to settle. */
export function stopRuntimeDataSetUpgrades(context: ExtensionContext): Promise<void> {
  const lifetime = lifetimeFor(context);
  lifetime.stopped = true;
  lifetime.stopping ??= Promise.allSettled([...lifetime.operations]).then(() => undefined);
  return lifetime.stopping;
}
