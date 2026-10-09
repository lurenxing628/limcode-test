import { normalizeAskUserToolRequest } from '../../shared/askUser';
import { validateCommandToolArguments } from '../../shared/commandToolArguments';
import { validateEditToolArguments } from '../../shared/editToolArguments';
import { validateDeleteToolArguments, validateWriteToolArguments } from '../../shared/fileToolArguments';
import { normalizeSubmitPlanToolRequest } from '../../shared/planReview';
import { requireTaskListOperation } from '../../shared/taskListProjection';
import { ToolArgumentError } from '../../shared/toolArgumentUtils';
import { TASK_LIST_TOOL_NAME, TRANSFER_TOOL_NAME } from '../../shared/protocol';
import { validateReadFileToolArguments } from '../world/modules/tools/definitions/readFile';
import { validateSkillsToolArguments } from '../world/modules/tools/definitions/skills';
import { validateReadAgentAnswerToolArguments, validateRunAgentToolArguments } from './childAgentCoordinator';
import { validateWorkEnvironmentTransferArguments } from './workEnvironmentTransferEffects';

/** Execution/policy projection only. The original ToolCall arguments remain the durable evidence. */
export function validateBuiltinToolArguments(toolName: string, args: unknown): unknown {
  try {
    switch (toolName) {
      case 'bash': case 'shell': return validateCommandToolArguments(args);
      case 'edit': return validateEditToolArguments(args);
      case 'write': return validateWriteToolArguments(args);
      case 'delete': return validateDeleteToolArguments(args);
      case 'read': return validateReadFileToolArguments(args);
      case 'ask_user': return normalizeAskUserToolRequest(args);
      case 'submit_plan': return normalizeSubmitPlanToolRequest(args);
      case TASK_LIST_TOOL_NAME: return requireTaskListOperation(args);
      case 'skills': return validateSkillsToolArguments(args);
      case 'run_agent': return validateRunAgentToolArguments(args);
      case 'read_agent_answer': return validateReadAgentAnswerToolArguments(args);
      case TRANSFER_TOOL_NAME: return validateWorkEnvironmentTransferArguments(args);
      default: return args;
    }
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    if (error instanceof Error) throw new ToolArgumentError(error.message);
    throw error;
  }
}
