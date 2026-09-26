import { randomUUID } from 'node:crypto';
import { BridgeMessageType, type BridgeClientId, type DataRootPromptPayload, type ExtensionToWebviewMessage } from '../shared/protocol';

export interface DataRootPromptAnswer {
  /** The chosen action key; 'cancel' when dismissed or when the page went away. */
  choice: string;
  /** Keys of the ticked options. */
  include: string[];
}

export interface DataRootPromptHost {
  postToWebview(clientId: BridgeClientId, message: ExtensionToWebviewMessage): boolean;
}

export type DataRootPrompt = Omit<DataRootPromptPayload, 'flowId'>;

const pending = new Map<string, { clientId: BridgeClientId; options: ReadonlySet<string>; resolve(answer: DataRootPromptAnswer): void }>();

/**
 * Confirmations of the data-directory commands are ConfirmPanels in the settings page that asked
 * (AGENTS §5.6.4); only the folder picker is native. The page answers with dataRoot.action 'answer';
 * a page that closes, or cannot be reached, answers 'cancel'.
 */
export function askInSettingsPage(host: DataRootPromptHost, clientId: BridgeClientId, prompt: DataRootPrompt): Promise<DataRootPromptAnswer> {
  const flowId = randomUUID();
  return new Promise((resolve) => {
    pending.set(flowId, { clientId, options: new Set((prompt.options ?? []).map((option) => option.key)), resolve });
    const posted = host.postToWebview(clientId, {
      id: randomUUID(),
      type: BridgeMessageType.DataRootPrompt,
      channel: 'settings',
      payload: { ...prompt, flowId }
    });
    if (!posted) settle(flowId, { choice: 'cancel', include: [] });
  });
}

/** The settings page answered one of its prompts; answers for another page or an unknown prompt are ignored. */
export function answerDataRootPrompt(clientId: BridgeClientId, answer: { flowId?: unknown; choice?: unknown; include?: unknown }): boolean {
  if (typeof answer.flowId !== 'string') return false;
  const entry = pending.get(answer.flowId);
  if (!entry || entry.clientId !== clientId) return false;
  const include = Array.isArray(answer.include)
    ? answer.include.filter((key): key is string => typeof key === 'string' && entry.options.has(key)) : [];
  settle(answer.flowId, { choice: typeof answer.choice === 'string' ? answer.choice : 'cancel', include });
  return true;
}

/** The page closed: its open prompts are cancelled. */
export function cancelDataRootPrompts(clientId: BridgeClientId): void {
  for (const [flowId, entry] of [...pending]) {
    if (entry.clientId === clientId) settle(flowId, { choice: 'cancel', include: [] });
  }
}

function settle(flowId: string, answer: DataRootPromptAnswer): void {
  const entry = pending.get(flowId);
  if (!entry) return;
  pending.delete(flowId);
  entry.resolve(answer);
}
