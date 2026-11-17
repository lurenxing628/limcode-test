import type { MessageContent, MessagePresentation, MsgRole } from './protocol';
import { isInternalMessage } from './messagePresentation';

export const DEFAULT_CONVERSATION_ID = 'default';
export const DEFAULT_CONVERSATION_TITLE = '新对话';
export const GENERATED_CONVERSATION_TITLE_PREFIX = `${DEFAULT_CONVERSATION_TITLE}-`;
export const DEFAULT_CONVERSATION_DISPLAY_TITLE = '默认对话';
export const DEFAULT_CONVERSATION_TITLE_MAX_LENGTH = 28;

export interface ConversationTitleMessage {
  role: MsgRole;
  presentation?: MessagePresentation;
  content: MessageContent;
  seq?: number;
  createdAt?: number;
}

export interface DisplayConversationTitleInput {
  id?: string;
  title?: string;
  messages?: readonly ConversationTitleMessage[];
  /** Host-projected title used when this client only has a bounded message window. */
  fallbackTitle?: string;
  maxLength?: number;
}

export function hasExplicitConversationTitle(title: string | undefined, conversationId?: string): boolean {
  const explicitTitle = normalizeConversationTitleText(title ?? '');
  if (!explicitTitle) return false;
  return !isPlaceholderConversationTitle(explicitTitle)
    && !isGeneratedConversationId(explicitTitle, conversationId);
}

export function displayConversationTitle(input: DisplayConversationTitleInput): string {
  const maxLength = input.maxLength ?? DEFAULT_CONVERSATION_TITLE_MAX_LENGTH;
  const explicitTitle = normalizeConversationTitleText(input.title ?? '');
  const placeholderTitle = isPlaceholderConversationTitle(explicitTitle);
  const generatedIdTitle = isGeneratedConversationId(explicitTitle, input.id);
  if (explicitTitle && !placeholderTitle && !generatedIdTitle) return truncateConversationTitle(explicitTitle, maxLength);

  const firstUserMessage = input.messages?.find((message) => message.role === 'user' && !isInternalMessage(message));
  const titleFromMessage = firstUserMessage ? normalizeConversationTitleText(conversationTitleTextPreview(firstUserMessage.content)) : '';
  if (titleFromMessage) return truncateConversationTitle(titleFromMessage, maxLength);

  const fallbackTitle = normalizeConversationTitleText(input.fallbackTitle ?? '');
  if (
    fallbackTitle
    && !isPlaceholderConversationTitle(fallbackTitle)
    && !isGeneratedConversationId(fallbackTitle, input.id)
  ) return truncateConversationTitle(fallbackTitle, maxLength);

  if (input.id === DEFAULT_CONVERSATION_ID) return DEFAULT_CONVERSATION_DISPLAY_TITLE;
  return explicitTitle && !generatedIdTitle ? truncateConversationTitle(explicitTitle, maxLength) : DEFAULT_CONVERSATION_TITLE;
}

export function displayConversationTitleFromText(text: string, maxLength = DEFAULT_CONVERSATION_TITLE_MAX_LENGTH): string {
  const normalized = normalizeConversationTitleText(text);
  return normalized ? truncateConversationTitle(normalized, maxLength) : DEFAULT_CONVERSATION_TITLE;
}

export function createNewConversationTitle(now = new Date()): string {
  const year = now.getFullYear();
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const hour = pad2(now.getHours());
  const minute = pad2(now.getMinutes());
  const second = pad2(now.getSeconds());
  const millisecond = now.getMilliseconds().toString().padStart(3, '0');
  return `${GENERATED_CONVERSATION_TITLE_PREFIX}${year}${month}${day}-${hour}${minute}${second}-${millisecond}`;
}

function conversationTitleTextPreview(content: MessageContent): string {
  for (const part of content.parts) {
    if ('text' in part && part.thought !== true && part.text.trim()) return part.text;
    if ('functionCall' in part) return `调用工具：${part.functionCall.name}`;
    if ('functionResponse' in part) return `工具返回：${part.functionResponse.name}`;
    if ('fileData' in part) return `文件：${part.fileData.uri}`;
    if ('inlineData' in part) return `附件：${part.inlineData.mimeType}`;
  }
  return '';
}

function normalizeConversationTitleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateConversationTitle(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function isGeneratedConversationId(text: string, conversationId: string | undefined): boolean {
  return text === conversationId || /^conversation-[a-z0-9-]+$/i.test(text);
}

function isPlaceholderConversationTitle(text: string): boolean {
  return text === DEFAULT_CONVERSATION_TITLE || text.startsWith(GENERATED_CONVERSATION_TITLE_PREFIX);
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}
