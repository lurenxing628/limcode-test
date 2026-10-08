const scenarios = [];
const push = (kind, ...names) => { for (const name of names) scenarios.push([name, kind]); };
push('empty', 'during-merge', 'pending-written', 'journal-create', 'staging-marker-after', 'selection-after', 'identity-after', 'complete-marker-after', 'publish-after', 'undo-work-removed',
  'undo-marked', 'undo-record-removed', 'notice-after', 'undo-marked@notice-after', 'undo-work-removed@notice-after');
// Retain the original numeric checkpoint ranges; filesystem evidence adds appends, so these ranges
// are sampled journal boundaries rather than a claim to cover every append of a whole relocation.
for (let n = 1; n <= 13; n += 1) push('empty', `journal-before:${n}`, `journal-after:${n}`);
push('limcode', 'journal-create', 'staging-marker-after', 'dbbackup-before-rename', 'identity-after', 'complete-marker-after', 'notice-after', 'publish-after',
  'undo-marked@notice-after',
  'undo-db-restored', 'undo-work-removed', 'undo-db-restored@dbbackup-journal-after',
  'undo-marked', 'undo-restored', 'undo-record-removed', 'undo-restored@complete-marker-after', 'undo-restored@dbbackup-journal-after',
  'undo-merge-restored', 'undo-merge-restored@notice-after');
for (let n = 1; n <= 19; n += 1) push('limcode', `journal-before:${n}`, `journal-after:${n}`);

export const RELOCATION_UNDO_CRASH_SCENARIOS = Object.freeze(scenarios.map((scenario) => Object.freeze(scenario)));
export const RELOCATION_UNDO_CRASH_GROUPS = Object.freeze(['empty', 'limcode']);
