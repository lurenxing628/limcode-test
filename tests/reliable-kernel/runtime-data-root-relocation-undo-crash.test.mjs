// Retained crash checkpoints are split by target kind to bound CI wall time.
import { registerRelocationUndoCrashTests } from './runtime-data-root-relocation-undo-crash-cases.mjs';

registerRelocationUndoCrashTests('empty');
