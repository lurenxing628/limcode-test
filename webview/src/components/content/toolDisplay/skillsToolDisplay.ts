import { IconBook } from '@tabler/icons-vue';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';
import { normalizeDisplayPath } from '@shared/displayPath';

interface SkillsArgs {
  name?: string;
  source?: string;
}

interface SkillsOutputRecord {
  name?: string;
  source?: string;
  entryPath?: string;
  body?: string;
}

export const skillsToolDisplay: ToolDisplayResolver = (context) => {
  const args = skillsArgs(context.args);
  const inputSections = skillsInputSections(args);
  const outputSections = skillsOutputSections(context);

  return {
    headerIcon: IconBook,
    ...(inputSections ? { inputSections } : {}),
    ...(outputSections ? { outputSections } : {})
  };
};

function skillsInputSections(args: SkillsArgs): ToolDisplaySection[] | undefined {
  const name = args.name?.trim();
  if (!name) return undefined;
  const source = args.source?.trim();
  return [{
    kind: 'input',
    title: '载入技能',
    rows: [{ label: '名称', value: name }, ...(source ? [{ label: '来源', value: source }] : [])],
    rowStyle: 'keyValue'
  }];
}

function skillsOutputSections(context: ToolDisplayContext): ToolDisplaySection[] | undefined {
  if (context.result === undefined) return undefined;

  const output = toolOutput(context.result);

  if (typeof output === 'string') {
    // A string output is the skills tool's explanation of why nothing was loaded.
    return output ? [{ kind: 'output', title: '未载入技能', text: output }] : undefined;
  }

  const record = outputRecord(output);
  if (!record) return undefined;

  const path = normalizeDisplayPath(record.entryPath);
  const loaded = [record.name?.trim(), record.source?.trim() ? `(${record.source.trim()})` : ''].filter(Boolean).join(' ');
  const title = ['技能内容', loaded, path].filter(Boolean).join(' · ');

  if (typeof record.body === 'string' && record.body.trim()) {
    return [{ kind: 'output', title, text: record.body, markdown: true }];
  }
  return undefined;
}

function skillsArgs(value: unknown): SkillsArgs {
  const record = asRecord(value);
  return record ? { name: stringValue(record.name), source: stringValue(record.source) } : {};
}

function toolOutput(result: unknown): unknown {
  const record = asRecord(result);
  return record && 'output' in record ? record.output : result;
}

function outputRecord(value: unknown): SkillsOutputRecord | undefined {
  const record = asRecord(value);
  return record ? record as SkillsOutputRecord : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
