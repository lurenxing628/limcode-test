import { IconMessageQuestion } from '@tabler/icons-vue';
import { askUserOutputFromResult, askUserRequestFromArgs } from '@shared/askUser';
import type { ToolDisplayResolver } from './types';

export const askUserToolDisplay: ToolDisplayResolver = (context) => {
  const request = askUserRequestFromArgs(context.args)
    ?? askUserRequestFromArgs(context.toolCall?.args);
  if (!request) return undefined;

  const call = context.toolCall;
  const output = askUserOutputFromResult(context.result);
  const reachedWaitingState = call?.status === 'awaiting_user_input'
    || !!output
    || context.events.some((event) => event.status === 'awaiting_user_input');
  if (!reachedWaitingState) {
    return {
      headerIcon: IconMessageQuestion,
      inputSections: [],
      ...(context.result === undefined ? { outputSections: [] } : {})
    };
  }

  const title = call?.status === 'awaiting_user_input' ? '需要你的回答' : '问题与回答';
  return {
    headerIcon: IconMessageQuestion,
    inputSections: [{
      kind: 'input',
      title,
      askUser: {
        request,
        ...(call ? { toolCall: call } : {})
      }
    }],
    ...(context.result === undefined || output ? { outputSections: [] } : {})
  };
};
