import type { NativeSteeringReceipt } from '@shared/openAIResponsesNative';

/** 只有具有完整后继身份、且同一请求没有其它回执认领同一前驱或后继时，才可标为已生效。 */
export function hasSteeringApplicationReceipt(
  receipt: NativeSteeringReceipt,
  requestReceipts: readonly NativeSteeringReceipt[] = []
): boolean {
  if (!((receipt.state === 'continuing' || receipt.state === 'completed')
    && Boolean(receipt.submissionId?.trim())
    && Boolean(receipt.conversationId?.trim())
    && Boolean(receipt.turnId?.trim())
    && Boolean(receipt.modelRequestId?.trim())
    && Boolean(receipt.messageId?.trim())
    && Boolean(receipt.targetResponseId?.trim())
    && Boolean(receipt.successorResponseId?.trim())
    && receipt.targetResponseId !== receipt.successorResponseId
    && (!receipt.responseId || receipt.responseId === receipt.successorResponseId))) return false;
  return !requestReceipts.some((other) =>
    other.submissionId !== receipt.submissionId
    && (other.state === 'continuing' || other.state === 'completed')
    && other.conversationId === receipt.conversationId
    && other.turnId === receipt.turnId
    && other.modelRequestId === receipt.modelRequestId
    && ((Boolean(other.targetResponseId) && other.targetResponseId === receipt.targetResponseId)
      || (Boolean(other.successorResponseId) && other.successorResponseId === receipt.successorResponseId))
  );
}
