import type { WorkEnvironmentRecord } from '../../../../shared/protocol';
import { formatWorkEnvironmentForDisplay } from '../../../../shared/workEnvironmentCatalog';

export const SWITCH_WORK_ENVIRONMENTS_TITLE = 'Switchable work environments (pass workEnvironmentId to switch precisely):';
export const TRANSFER_WORK_ENVIRONMENTS_TITLE = 'Work environments available for file transfer (pass the leading W# reference as fromEnvironment/toEnvironment; current refers to the active one):';

/**
 * 把可用工作环境列表渲染为工具描述文本。
 * ECS schema contributor 与 reliableKernel toolDispatcher 共用此纯函数。
 */
export function workEnvironmentListText(
  environments: readonly WorkEnvironmentRecord[],
  title: string = SWITCH_WORK_ENVIRONMENTS_TITLE
): string {
  if (environments.length === 0) return 'There are currently no switchable work environments.';
  const lines = [
    title,
    ...environments.slice(0, 20).map((environment) => `- ${formatWorkEnvironmentForDisplay(environment)}`)
  ];
  if (environments.length > 20) lines.push(`...and ${environments.length - 20} more work environment(s) not listed`);
  return lines.join('\n');
}

/** 给 switch_work_environment 的 workEnvironmentId 参数追加环境列表提示。 */
export function withWorkEnvironmentIdParameterHints(parameters: unknown, environmentText: string): unknown {
  if (!isPlainObject(parameters)) return parameters;
  const properties = isPlainObject(parameters.properties) ? parameters.properties : undefined;
  const workEnvironmentId = isPlainObject(properties?.workEnvironmentId) ? properties.workEnvironmentId : undefined;
  if (!properties || !workEnvironmentId) return parameters;
  return {
    ...parameters,
    properties: {
      ...properties,
      workEnvironmentId: {
        ...workEnvironmentId,
        description: `${typeof workEnvironmentId.description === 'string' ? workEnvironmentId.description : 'Target work environment id.'}\n${environmentText}`
      }
    }
  };
}

/** 给 transfer 的 fromEnvironment/toEnvironment 参数追加环境列表提示。 */
export function withTransferEnvironmentParameterHints(parameters: unknown, environmentText: string): unknown {
  if (!isPlainObject(parameters)) return parameters;
  const properties = isPlainObject(parameters.properties) ? parameters.properties : undefined;
  const transfers = isPlainObject(properties?.transfers) ? properties.transfers : undefined;
  const items = isPlainObject(transfers?.items) ? transfers.items : undefined;
  const itemProperties = isPlainObject(items?.properties) ? items.properties : undefined;
  if (!properties || !transfers || !items || !itemProperties) return parameters;
  return {
    ...parameters,
    properties: {
      ...properties,
      transfers: {
        ...transfers,
        items: {
          ...items,
          properties: withEnvironmentFieldDescriptions(itemProperties, environmentText)
        }
      }
    }
  };
}

function withEnvironmentFieldDescriptions(properties: Record<string, unknown>, environmentText: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => {
    if ((key === 'fromEnvironment' || key === 'toEnvironment') && isPlainObject(value)) {
      return [key, {
        ...value,
        description: `${typeof value.description === 'string' ? value.description : 'Work environment id.'}\n${environmentText}`
      }];
    }
    return [key, value];
  }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
