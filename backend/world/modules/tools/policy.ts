import type { ToolPolicyRecord } from '../../../../shared/protocol';

export function isYoloToolPolicy(policy: Pick<ToolPolicyRecord, 'preset'> | undefined): boolean {
  return policy?.preset === 'yolo';
}
