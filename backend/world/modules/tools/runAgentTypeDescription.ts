import { DEFAULT_RUN_AGENT_TYPE } from './definitions/runAgent';

export interface AgentTypeListEntry {
  id: string;
  label?: string;
}

/** 渲染 runAgent 可用的 agent.type 列表（按 id 去重，保持入参顺序）。 */
export function formatAgentTypeList(entries: readonly AgentTypeListEntry[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = entry.label?.trim();
    lines.push(label ? `- ${id}: ${label}` : `- ${id}`);
  }
  return lines.join('\n');
}

/**
 * 把可用 agent.type 列表注入 runAgent 工具描述与 agent.type 参数提示。
 * reliableKernel toolDispatcher 使用的纯描述函数。
 */
export function augmentRunAgentToolSchema<T extends { description: string; parameters: unknown }>(
  tool: T,
  typeList: string
): T {
  if (!typeList) return tool;
  const parameters = cloneRecord(tool.parameters);
  const properties = cloneRecord(parameters.properties);
  const agent = cloneRecord(properties.agent);
  const agentProperties = cloneRecord(agent.properties);
  const typeProperty = cloneRecord(agentProperties.type);

  typeProperty.description = [
    `The Agent type/configuration id to use. Defaults to ${DEFAULT_RUN_AGENT_TYPE}. Use one of the available Agent types below. Runtime mirror ids are internal implementation details and are not valid Agent types; continue an existing child conversation with answerBridgeId instead.`,
    'Available Agent types (pass one as agent.type):',
    typeList
  ].join('\n');
  agentProperties.type = typeProperty;
  agent.properties = agentProperties;
  properties.agent = agent;
  parameters.properties = properties;

  return {
    ...tool,
    description: `${tool.description}\n\nPrefer answerBridgeId when continuing an existing child conversation. When creating a new child Agent, choose an agent.type from this list (type/config id + description only; runtime mirror ids are intentionally hidden):\n${typeList}`,
    parameters
  };
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
