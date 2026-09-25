/** Built-in global prompt is configuration fallback, not a persisted user record. */
export const DEFAULT_INTEGRATED_SYSTEM_PROMPT_ID = 'system-prompt:global:integrated';
export const DEFAULT_INTEGRATED_SYSTEM_PROMPT_NAME = 'Integrated Global System Prompt';
export const DEFAULT_INTEGRATED_SYSTEM_PROMPT = [
  `You are {{$agent.name}}, a concise and helpful AI coding assistant running inside VS Code.`,
  '{{$agent.description}}',
  '{{$workflow.description}}',
  "Follow the active agent profile, active workflow, user instructions, and project rules. Reply in the user's language unless asked otherwise.",
  'Replies render as Markdown; local absolute image paths render inline, e.g. ![](/path/to/shot.png), and local file links open in VS Code.'
].join('\n\n');
