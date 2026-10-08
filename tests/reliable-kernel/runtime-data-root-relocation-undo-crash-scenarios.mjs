const scenarios = [];
const push = (kind, ...names) => { for (const name of names) scenarios.push([name, kind]); };
push('empty', 'during-merge', 'pending-written', 'journal-create', 'staging-marker-after', 'selection-after', 'identity-after', 'complete-marker-after', 'publish-after', 'undo-work-removed',
  'undo-marked', 'undo-record-removed', 'notice-after', 'undo-marked@notice-after', 'undo-work-removed@notice-after');
// Every journal append of a whole relocation (count: empty 13, limcode 19; the existing target's first one lists its CAS), the carried merge records included.
for (let n = 1; n <= 13; n += 1) push('empty', `journal-before:${n}`, `journal-after:${n}`);
push('limcode', 'journal-create', 'staging-marker-after', 'dbbackup-before-rename', 'identity-after', 'complete-marker-after', 'notice-after', 'publish-after',
  'undo-marked@notice-after',
  'undo-db-restored', 'undo-work-removed', 'undo-db-restored@dbbackup-journal-after',
  'undo-marked', 'undo-restored', 'undo-record-removed', 'undo-restored@journal-before:13', 'undo-restored@journal-before:6',
  'undo-merge-restored', 'undo-merge-restored@journal-after:18');
for (let n = 1; n <= 19; n += 1) push('limcode', `journal-before:${n}`, `journal-after:${n}`);

export const RELOCATION_UNDO_CRASH_SCENARIOS = Object.freeze(scenarios.map((scenario) => Object.freeze(scenario)));
export const RELOCATION_UNDO_CRASH_GROUPS = Object.freeze(['empty', 'limcode']);
