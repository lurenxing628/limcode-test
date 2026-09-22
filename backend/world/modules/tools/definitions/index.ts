import type { ToolDefinition } from '../registry';
import { readAgentAnswerToolModule, submitAgentAnswerToolModule } from './agentAnswer';
import { askUserToolModule } from './askUser';
import { commandToolModule } from './command';
import { deleteToolModule } from './delete';
import { editToolModule } from './edit';
import { readFileToolModule } from './readFile';
import { runAgentToolModule } from './runAgent';
import { agentCollaborationToolModules } from './agentCollaboration';
import { submitPlanToolModule } from './submitPlan';
import { switchWorkEnvironmentToolModule } from './switchWorkEnvironment';
import { taskListToolModule } from './taskList';
import { transferFilesToolModule } from './transferFiles';
import { writeToolModule } from './write';
import { skillsToolModule } from './skills';
import type { ToolDefinitionContext, ToolDefinitionModule } from './types';

export * from './types';
export * from './agentCollaboration';
export * from './agentBoard';
export { askUserTool, askUserToolModule } from './askUser';
export { submitPlanTool, submitPlanToolModule } from './submitPlan';
export { readAgentAnswerTool, readAgentAnswerToolModule, submitAgentAnswerTool, submitAgentAnswerToolModule } from './agentAnswer';
export { commandToolModule, createCommandTool } from './command';
export { deleteToolModule, deleteTool } from './delete';
export { editToolModule, editTool } from './edit';
export { readFileToolModule, readFileTool } from './readFile';
export { writeToolModule, writeTool } from './write';
export { runAgentToolModule, runAgentTool } from './runAgent';
export { switchWorkEnvironmentToolModule, switchWorkEnvironmentTool } from './switchWorkEnvironment';
export { taskListToolModule, taskListTool } from './taskList';
export { transferFilesToolModule, transferFilesTool } from './transferFiles';
export { skillsToolModule, skillsTool } from './skills';

const BUILTIN_TOOL_MODULES: readonly ToolDefinitionModule[] = [
  taskListToolModule,
  askUserToolModule,
  submitPlanToolModule,
  switchWorkEnvironmentToolModule,
  transferFilesToolModule,
  readFileToolModule,
  editToolModule,
  writeToolModule,
  deleteToolModule,
  skillsToolModule,
  submitAgentAnswerToolModule,
  readAgentAnswerToolModule,
  runAgentToolModule,
  ...agentCollaborationToolModules,
  commandToolModule
];

export function createBuiltinToolDefinitions(context: ToolDefinitionContext): ToolDefinition[] {
  return BUILTIN_TOOL_MODULES.map((module) => module.create(context));
}
