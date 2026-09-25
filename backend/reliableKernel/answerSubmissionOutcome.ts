import type { ReliableKernelAnswerOutcome } from '../../shared/reliableKernelClientFeed';
import { stablePhaseFId } from './phaseFIdentity';
import { requireRuntimeId } from './runtimeSqlRows';

/**
 * How the kernel classifies one child answer for clients: the interrupted bit marks a partial
 * answer, and a failed child run publishes the stable failed-submission id reserved for that child
 * Turn (answerDelivery `ensureFailed`); anything else is a submitted final answer.
 */
export function answerSubmissionClientOutcome(
  submission: Record<string, unknown>,
  childExecutionId: string
): ReliableKernelAnswerOutcome {
  const interrupted = submission.interrupted;
  if (interrupted === 1n || interrupted === 1) return 'interrupted';
  if (interrupted !== 0n && interrupted !== 0) {
    throw new Error(`AnswerSubmission ${String(submission.id)} has unsupported interrupted flag ${String(interrupted)}.`);
  }
  const turnId = requireRuntimeId(submission.turn_id);
  return submission.id === stablePhaseFId('answer_submission', 'child-drive-failed', childExecutionId, turnId)
    ? 'failed' : 'submitted';
}
