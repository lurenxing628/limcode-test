import { computed, shallowRef, watch } from 'vue';

type DraftFields = Record<string, string | boolean>;

function sameFields<T extends DraftFields>(left: T, right: T): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

/** A flat, local form draft. Incoming snapshots update the baseline, never newer local edits. */
export function useGuardedSettingsDraft<T extends DraftFields>(
  readScope: () => string,
  readSaved: () => T
) {
  const draft = shallowRef<T>({ ...readSaved() });
  const saved = shallowRef<T>({ ...readSaved() });
  const externalChange = shallowRef(false);
  const editRevision = shallowRef(0);
  const acknowledgedEditRevision = shallowRef(0);
  const submission = shallowRef<{ revision: number; value: T; requestId: string }>();
  const value = computed({
    get: () => draft.value,
    set: (incoming: T) => {
      if (!sameFields(draft.value, incoming)) editRevision.value++;
      draft.value = { ...incoming };
    }
  });
  const dirty = computed(() => editRevision.value > acknowledgedEditRevision.value || !sameFields(value.value, saved.value));
  const remoteChanged = computed(() => dirty.value && externalChange.value);
  let scope: string | undefined;
  let scopeRevision = 0;

  function reset(): void {
    const incoming = { ...readSaved() };
    saved.value = incoming;
    draft.value = { ...incoming };
    externalChange.value = false;
    acknowledgedEditRevision.value = editRevision.value;
    submission.value = undefined;
  }

  function markSubmitted(requestId: string): void {
    if (dirty.value || submission.value) submission.value = { revision: editRevision.value, value: { ...value.value }, requestId };
  }

  function confirmSubmitted(requestId: string): void {
    const sent = submission.value;
    if (!sent || sent.requestId !== requestId) return;
    if (editRevision.value === sent.revision) draft.value = { ...saved.value };
    acknowledgedEditRevision.value = sent.revision;
    submission.value = undefined;
    if (!dirty.value) externalChange.value = false;
  }

  /** Explicit reads may reset the draft only if nothing was edited or rebound while awaiting them. */
  function prepareReset(): () => void {
    const revision = editRevision.value;
    const binding = scopeRevision;
    return () => {
      if (revision === editRevision.value && binding === scopeRevision) reset();
    };
  }

  watch([readScope, readSaved], ([nextScope, incoming]) => {
    if (scope === nextScope && sameFields(saved.value, incoming)) return;
    if (scope !== nextScope) scopeRevision++;
    const sent = submission.value;
    const preserveSubmission = !!sent && (editRevision.value > sent.revision || !sameFields(sent.value, incoming));
    if (scope !== nextScope || (!dirty.value && !preserveSubmission)) {
      draft.value = { ...incoming };
      acknowledgedEditRevision.value = editRevision.value;
      externalChange.value = false;
    } else {
      externalChange.value = true;
    }
    saved.value = { ...incoming };
    if (scope !== nextScope) submission.value = undefined;
    scope = nextScope;
  }, { immediate: true, flush: 'sync' });

  return { value, dirty, remoteChanged, reset, markSubmitted, confirmSubmitted, prepareReset };
}
