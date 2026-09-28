import { defineStore } from 'pinia';
import { BridgeMessageType, type DataRootPromptPayload } from '@shared/protocol';
import { bridge } from '@webview/transport';

let installed = false;

/**
 * Confirmations of the data-directory commands (migrate, go back, delete the old directory): the
 * extension sends one prompt at a time to the settings page that started the command and waits for
 * its answer.
 */
export const useDataRootPromptStore = defineStore('data-root-prompt', {
  state: () => ({ prompt: undefined as DataRootPromptPayload | undefined, include: [] as string[] }),
  actions: {
    initialize(): void {
      if (installed) return;
      installed = true;
      bridge.on(BridgeMessageType.DataRootPrompt, (message) => {
        if (!message.payload) return;
        // A newer prompt of the same page supersedes an unanswered one (its command already moved on).
        if (this.prompt) this.send(this.prompt.flowId, 'cancel', []);
        this.prompt = message.payload;
        // Options the command ticks by default start ticked; every other one starts unticked.
        this.include = [...(message.payload.options ?? []), ...message.payload.sections.flatMap((section) => section.options ?? [])]
          .filter((option) => option.checked === true).map((option) => option.key);
      });
    },
    toggle(key: string, ticked: boolean): void {
      this.include = ticked ? [...new Set([...this.include, key])] : this.include.filter((item) => item !== key);
    },
    answer(choice: string): void {
      const prompt = this.prompt;
      if (!prompt) return;
      this.prompt = undefined;
      this.send(prompt.flowId, choice, choice === 'cancel' ? [] : this.include);
      this.include = [];
    },
    send(flowId: string, choice: string, include: string[]): void {
      bridge.request(BridgeMessageType.DataRootAction, { action: 'answer', flowId, choice, include: [...include] });
    }
  }
});
