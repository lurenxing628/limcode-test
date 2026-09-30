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
  let editRevision = 0;
  let submission: { revision: number; value: T } | undefined;
  const value = computed({
    get: () => draft.value,
    set: (incoming: T) => {
      if (!sameFields(draft.value, incoming)) editRevision++;
      draft.value = { ...incoming };
    }
  });
  const dirty = computed(() => !sameFields(value.value, saved.value));
  const remoteChanged = computed(() => dirty.value && externalChange.value);
  let scope: string | undefined;

  function reset(): void {
    const incoming = { ...readSaved() };
    saved.value = incoming;
    draft.value = { ...incoming };
    externalChange.value = false;
    submission = undefined;
  }

  function markSubmitted(): void {
    if (dirty.value || submission) submission = { revision: editRevision, value: { ...value.value } };
  }

  watch([readScope, readSaved], ([nextScope, incoming]) => {
    if (scope === nextScope && sameFields(saved.value, incoming)) return;
    const preserveSubmission = !!submission && (editRevision > submission.revision || !sameFields(submission.value, incoming));
    if (scope !== nextScope || (!dirty.value && !preserveSubmission) || sameFields(value.value, incoming)) {
      draft.value = { ...incoming };
      externalChange.value = false;
    } else {
      externalChange.value = true;
    }
    saved.value = { ...incoming };
    if (scope !== nextScope || (submission && sameFields(submission.value, incoming))) submission = undefined;
    scope = nextScope;
  }, { immediate: true, flush: 'sync' });

  return { value, dirty, remoteChanged, reset, markSubmitted };
}
