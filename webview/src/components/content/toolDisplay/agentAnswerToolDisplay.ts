import { IconUsers } from '@tabler/icons-vue';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';

export const readAgentAnswerToolDisplay: ToolDisplayResolver = (context) => {
  const answer = answerFromValue(context.result);
  if (!answer?.content) {
    return { headerIcon: IconUsers };
  }

  return {
    headerIcon: IconUsers,
    outputSections: [answerMarkdownSection(answer.title ?? '回答正文', answer.content)]
  };
};

export const submitAgentAnswerToolDisplay: ToolDisplayResolver = (context) => {
  const args = answerFromValue(context.args);
  const result = answerSubmitResult(context.result);
  const inputSections: ToolDisplaySection[] = [];

  if (args?.title) {
    inputSections.push({
      kind: 'input',
      title: '提交信息',
      rows: [{ label: '标题', value: args.title }],
      rowStyle: 'keyValue'
    });
  }
  if (args?.content) inputSections.push(answerMarkdownSection('提交回答正文', args.content, 'input'));

  return {
    headerIcon: IconUsers,
    inputSections,
    ...(result ? { outputSections: [{
      kind: 'output',
      title: '提交结果',
      rows: [
        { label: '是否成功', value: result.ok === undefined ? '未知' : result.ok ? '是' : '否' },
        ...(result.updated !== undefined ? [{ label: '是否更新', value: result.updated ? '是' : '否' }] : [])
      ],
      rowStyle: 'keyValue'
    }] } : {})
  };
};

export function answerMarkdownSection(title: string, content: string, kind: 'input' | 'output' = 'output'): ToolDisplaySection {
  return { kind, title, text: content, markdown: true };
}

export function answerFromValue(value: unknown): { title?: string; content?: string } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const title = stringValue(record.title);
  const content = stringValue(record.content);
  return title || content ? { ...(title ? { title } : {}), ...(content ? { content } : {}) } : undefined;
}

function answerSubmitResult(value: unknown): { ok?: boolean; updated?: boolean } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const ok = typeof record.ok === 'boolean' ? record.ok : undefined;
  const updated = typeof record.updated === 'boolean' ? record.updated : undefined;
  return ok !== undefined || updated !== undefined
    ? { ...(ok !== undefined ? { ok } : {}), ...(updated !== undefined ? { updated } : {}) }
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
