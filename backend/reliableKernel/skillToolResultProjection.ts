import { SKILLS_TOOL_NAME, type MessageContent } from '../../shared/protocol';
import { renderLoadedSkill } from '../world/modules/skill/skillLookup';
import type { SkillsToolOutput } from '../world/modules/tools/definitions/skills';
import { estimateMessageContentsTokens, estimateTextTokens } from './modelTokenEstimator';
import { PRELOADED_SKILLS_HEADER, splitPreloadedSkills } from './childSkillPreload';

const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';

/**
 * Model-visible allowance of one loaded skill. Claude Code keeps a loaded skill whole, and nearly
 * every SKILL.md is far below this (the Agent Skills guidance keeps SKILL.md under ~5k tokens and moves
 * detail into references/), so the cap only bounds pathological files. The allowance is the skill's
 * own: other results of the same tool batch never share it.
 */
export const SKILL_TOOL_RESULT_MAX_TOKENS = 25_000;

/**
 * Skills re-attached after a compression removed their loads, as Claude Code does after compaction:
 * the head of each skill, most recent load first, within a total. The total is further bounded by
 * a share of the post-compression body target (see the compression coordinator), so a small target
 * is not consumed by skills before the summary and the retained tail.
 */
export const SKILL_REATTACHMENT_PER_SKILL_TOKENS = 5_000;
export const SKILL_REATTACHMENT_TOTAL_TOKENS = 25_000;
export const SKILL_REATTACHMENT_MAX_BODY_TARGET_SHARE = 0.25;
/** Below this room a skill is only named: a stub of its first lines would read as the whole skill. */
const SKILL_REATTACHMENT_MIN_TOKENS = 500;

/** First line of the re-attachment content; it also identifies that content in a compression segment. */
export const SKILL_REATTACHMENT_HEADER = '[Skills loaded earlier in this conversation]';
const SKILL_REATTACHMENT_NOTE = 'These skills were loaded (with the skills tool, or preloaded for this task) before the conversation was compressed, and their '
  + 'instructions still apply: continue from the step you had reached (the compressed history above records it). '
  + 'A skill shortened here says where its SKILL.md continues; read the rest with the read tool before relying on '
  + 'a missing step.';
const SKILL_REATTACHMENT_OMITTED_PREFIX = 'Loaded earlier but not re-attached for lack of room (load again with the skills tool before following them): ';
const CUT_LINE_QUOTE_MAX_CHARS = 160;

/** A succeeded `skills` load as its committed tool result stores it: `{ status, detail: { ok, output } }`. */
export function loadedSkillFromToolResult(value: unknown): SkillsToolOutput | undefined {
  const envelope = asRecord(value);
  if (envelope?.status !== 'succeeded') return undefined;
  const detail = asRecord(envelope.detail);
  const output = detail?.ok === true ? asRecord(detail.output) : undefined;
  if (!output
    || typeof output.name !== 'string' || !output.name.trim()
    || typeof output.source !== 'string'
    || typeof output.baseDirectory !== 'string'
    || typeof output.entryPath !== 'string'
    || typeof output.body !== 'string'
    || typeof output.bodyStartLine !== 'number' || !Number.isSafeInteger(output.bodyStartLine) || output.bodyStartLine < 1
    || (output.pluginRoot !== undefined && typeof output.pluginRoot !== 'string')) {
    return undefined;
  }
  return {
    name: output.name,
    source: output.source,
    baseDirectory: output.baseDirectory,
    ...(typeof output.pluginRoot === 'string' ? { pluginRoot: output.pluginRoot } : {}),
    entryPath: output.entryPath,
    body: output.body,
    bodyStartLine: output.bodyStartLine
  };
}

/** The explanation of a `skills` load the tool itself refused (unknown, turned off or ambiguous name). */
export function skillLoadFailureText(value: unknown): string | undefined {
  const envelope = asRecord(value);
  if (!envelope || envelope.status === 'succeeded') return undefined;
  const detail = asRecord(envelope.detail);
  return detail?.ok === false && typeof detail.output === 'string' ? detail.output : undefined;
}

export type SkillRenderPurpose = 'tool_result' | 'reattachment';

export interface RenderedSkill {
  text: string;
  /** Set when the body was cut: the SKILL.md line where reading continues. */
  rereadStartLine?: number;
}

/**
 * Renders a loaded skill exactly as the model reads it (renderLoadedSkill). A skill over `maxTokens`
 * keeps the head of its body, cut at a line boundary, and states in the text where it was cut and
 * how to read the rest. Undefined when not even the skill header and the notice fit.
 */
export function renderSkillWithinTokens(
  skill: SkillsToolOutput,
  maxTokens: number,
  purpose: SkillRenderPurpose,
  measure: (text: string) => number = estimateTextTokens
): RenderedSkill | undefined {
  const full = renderLoadedSkill(skill, skill.body);
  if (measure(full) <= maxTokens) return { text: full };
  const lines = skill.body.split('\n');
  const render = (shown: number): string => renderLoadedSkill(
    skill,
    [...lines.slice(0, shown), '', skillCutNotice(skill, lines, shown, purpose)].join('\n')
  );
  let low = 0;
  let high = lines.length - 1;
  let best: string | undefined;
  let bestShown = 0;
  while (low <= high) {
    const shown = Math.floor((low + high) / 2);
    const candidate = render(shown);
    if (measure(candidate) <= maxTokens) {
      best = candidate;
      bestShown = shown;
      low = shown + 1;
    } else {
      high = shown - 1;
    }
  }
  return best === undefined ? undefined : { text: best, rereadStartLine: skill.bodyStartLine + bestShown };
}

/**
 * Where a cut skill continues: the SKILL.md line of the first omitted body line (the body starts at
 * bodyStartLine, below the frontmatter). That line is also quoted so the continuation is unambiguous.
 */
function skillCutNotice(
  skill: SkillsToolOutput,
  lines: readonly string[],
  shown: number,
  purpose: SkillRenderPurpose
): string {
  const startLine = skill.bodyStartLine + shown;
  const firstOmitted = lines[shown] ?? '';
  const quoted = firstOmitted.length > CUT_LINE_QUOTE_MAX_CHARS
    ? `${firstOmitted.slice(0, CUT_LINE_QUOTE_MAX_CHARS)}…`
    : firstOmitted;
  const shownRange = shown > 0 ? `lines 1-${shown}` : 'none of the lines';
  const opening = purpose === 'tool_result'
    ? `[SKILL.md truncated here: a loaded skill keeps at most ${SKILL_TOOL_RESULT_MAX_TOKENS} tokens in one tool result. `
      + `Shown above: ${shownRange} of the skill body (${lines.length} lines).`
    : `[Re-attached after context compression and shortened: ${shownRange} of the skill body (${lines.length} lines) are shown.`;
  const action = purpose === 'tool_result'
    ? 'Before you act on this skill, read the rest of SKILL.md with the read tool'
    : 'Read the rest of SKILL.md with the read tool before relying on a step that is missing here';
  return [
    `${opening} The rest begins with the line:`,
    `> ${quoted}`,
    `${action}: path ${JSON.stringify(skill.entryPath)}, startLine ${startLine}.]`,
    `rereadHint: ${JSON.stringify({ kind: 'file', path: skill.entryPath, startLine })}`
  ].join('\n');
}

/** The minimal stored Context item shape the re-attachment reads (see StoredModelFacingContextItem). */
export interface SkillReattachmentSourceItem {
  segmentKind: string;
  messageRole?: string | null;
  contentType: string;
  content: string;
}

export interface SkillReattachmentPlan {
  /** Appended after the compression result; it is part of the committed compression contents. */
  content: MessageContent;
  /** Skills re-attached, most recent load first. */
  skills: string[];
  /** Skills loaded earlier that did not fit; the note asks the model to load them again. */
  omitted: string[];
  estimatedTokens: number;
}

/**
 * Re-attaches the skills whose loads a compression removes from the model window. Pure over the
 * committed Context items, so a retried or recovered compression derives the same bytes:
 * - succeeded `skills` tool results in the compressed items, and skills an earlier compression in them
 *   re-attached (carried forward verbatim), most recent first and deduplicated by skill name;
 * - a skill whose load is still in the retained items is skipped, the model sees it there;
 * - each skill keeps at most SKILL_REATTACHMENT_PER_SKILL_TOKENS of its head, within `budgetTokens`
 *   in total; skills that do not fit are named so the model can load them again.
 */
export function planSkillReattachment(input: {
  compressed: readonly SkillReattachmentSourceItem[];
  retained: readonly SkillReattachmentSourceItem[];
  budgetTokens: number;
}): SkillReattachmentPlan | undefined {
  // Keyed by name and source: two different skills may share a name across sources.
  const retainedKeys = new Set(input.retained.flatMap((item) => {
    const skill = item.segmentKind === 'tool_pair' ? storedSkillLoad(item.content) : undefined;
    return skill ? [skillKey(skill.name, skill.source)] : preloadedSkillLoads(item).map((load) => load.key);
  }));
  const seen = new Set<string>();
  const texts: string[] = [];
  const skills: string[] = [];
  const omitted: string[] = [];
  let remaining = Math.max(0, Math.floor(input.budgetTokens));
  for (const load of skillLoadsInOrder(input.compressed).reverse()) {
    if (seen.has(load.key) || retainedKeys.has(load.key)) continue;
    seen.add(load.key);
    const cap = Math.min(SKILL_REATTACHMENT_PER_SKILL_TOKENS, remaining);
    const text = cap >= SKILL_REATTACHMENT_MIN_TOKENS ? load.render(cap) : undefined;
    if (text === undefined) {
      omitted.push(load.name);
      continue;
    }
    remaining -= estimateTextTokens(text);
    texts.push(text);
    skills.push(load.name);
  }
  if (skills.length === 0 && omitted.length === 0) return undefined;
  const header = [
    SKILL_REATTACHMENT_HEADER,
    SKILL_REATTACHMENT_NOTE,
    ...(omitted.length > 0 ? [`${SKILL_REATTACHMENT_OMITTED_PREFIX}${omitted.join(', ')}`] : [])
  ].join('\n');
  const content: MessageContent = { role: 'user', parts: [{ text: header }, ...texts.map((text) => ({ text }))] };
  return { content, skills, omitted, estimatedTokens: estimateMessageContentsTokens([content]) };
}

/** Whether a compression content is the skill re-attachment written by planSkillReattachment. */
export function isSkillReattachmentContent(content: MessageContent): boolean {
  const first = content.role === 'user' ? content.parts[0] : undefined;
  return !!first && 'text' in first && typeof first.text === 'string'
    && first.text.startsWith(`${SKILL_REATTACHMENT_HEADER}\n`);
}

/**
 * What a summary writer is told instead of a re-attachment it would otherwise read in full: the
 * kernel re-attaches those skills again, the summary only has to keep their names and the step reached.
 */
export function skillReattachmentSummaryNote(content: MessageContent): string {
  const { skills, omitted } = reattachedSkills(content);
  const names = [...skills.map((skill) => skill.name), ...omitted];
  return `[Skills loaded earlier in this conversation: ${names.join(', ') || 'none'}. They are re-attached `
    + 'automatically after compression; the summary must keep their names and the step each one had reached.]';
}

interface SkillLoadOccurrence {
  name: string;
  /** Name and source; an omitted skill recorded by name only has an empty source. */
  key: string;
  render(maxTokens: number): string | undefined;
}

function skillKey(name: string, source: string): string {
  return JSON.stringify([name, source]);
}

/** The key of a skill rendered by renderLoadedSkill, read from its opening tag. */
function renderedSkillKey(text: string): { name: string; key: string } | undefined {
  const tag = /^<skill name="(.*?)" source="(.*?)">/.exec(text);
  return tag ? { name: tag[1], key: skillKey(tag[1], tag[2]) } : undefined;
}

/** Skill loads of the given items, oldest first. */
function skillLoadsInOrder(items: readonly SkillReattachmentSourceItem[]): SkillLoadOccurrence[] {
  const loads: SkillLoadOccurrence[] = [];
  for (const item of items) {
    if (item.segmentKind === 'tool_pair') {
      const skill = storedSkillLoad(item.content);
      if (skill) {
        loads.push({
          name: skill.name,
          key: skillKey(skill.name, skill.source),
          render: (maxTokens) => renderSkillWithinTokens(skill, maxTokens, 'reattachment')?.text
        });
      }
      continue;
    }
    if (item.segmentKind === 'message') {
      loads.push(...preloadedSkillLoads(item));
      continue;
    }
    if (item.segmentKind !== 'compression') continue;
    for (const content of storedCompressionContents(item)) {
      if (!isSkillReattachmentContent(content)) continue;
      const { skills, omitted } = reattachedSkills(content);
      // Stored most recent first; an earlier compression's skills are older than every later load.
      loads.push(...omitted.reverse().map((name) => ({ name, key: skillKey(name, ''), render: () => undefined })));
      loads.push(...skills.reverse().map(({ name, key, text }) => ({
        name,
        key,
        render: (maxTokens: number) => estimateTextTokens(text) <= maxTokens ? text : undefined
      })));
    }
  }
  return loads;
}

/**
 * Skills a parent preloaded into a child's first input (run_agent `skills`), as the child read them.
 * They are re-attached whole or, when over the allowance, named so the child loads them again: the
 * stored block does not record where its body starts in SKILL.md, so it is never cut.
 */
function preloadedSkillLoads(item: SkillReattachmentSourceItem): SkillLoadOccurrence[] {
  if (item.segmentKind !== 'message' || !item.content.includes(PRELOADED_SKILLS_HEADER)) return [];
  // A child's first input is stored as its plain text; a message content form carries it as text parts.
  const texts = item.contentType === 'text/plain'
    ? (item.messageRole === 'user' ? [item.content] : [])
    : item.contentType === MESSAGE_CONTENT_TYPE ? userMessageTexts(item.content) : [];
  return texts.flatMap((text) => splitPreloadedSkills(text)?.skills ?? []).map(({ name, text }) => ({
    name,
    key: renderedSkillKey(text)?.key ?? skillKey(name, ''),
    render: (maxTokens: number) => estimateTextTokens(text) <= maxTokens ? text : undefined
  }));
}

function userMessageTexts(content: string): string[] {
  const message = asRecord(parseJson(content));
  if (message?.role !== 'user' || !Array.isArray(message.parts)) return [];
  return message.parts.flatMap((part) => {
    const text = asRecord(part)?.text;
    return typeof text === 'string' ? [text] : [];
  });
}

function reattachedSkills(content: MessageContent): { skills: Array<{ name: string; key: string; text: string }>; omitted: string[] } {
  const skills = content.parts.slice(1).flatMap((part) => {
    if (!('text' in part) || typeof part.text !== 'string') return [];
    const rendered = renderedSkillKey(part.text);
    return rendered ? [{ ...rendered, text: part.text }] : [];
  });
  const header = content.parts[0] && 'text' in content.parts[0] ? content.parts[0].text : '';
  const omittedLine = header.split('\n').find((line) => line.startsWith(SKILL_REATTACHMENT_OMITTED_PREFIX));
  const omitted = omittedLine
    ? omittedLine.slice(SKILL_REATTACHMENT_OMITTED_PREFIX.length).split(', ').map((name) => name.trim()).filter(Boolean)
    : [];
  return { skills, omitted };
}

function storedSkillLoad(content: string): SkillsToolOutput | undefined {
  // Only a skills pair can hold one; skip parsing every other tool result.
  if (!content.includes(`"${SKILLS_TOOL_NAME}"`)) return undefined;
  const pair = asRecord(parseJson(content));
  const call = asRecord(pair?.toolCall);
  const result = asRecord(pair?.toolModelResult);
  if (call?.toolName !== SKILLS_TOOL_NAME || !result) return undefined;
  return loadedSkillFromToolResult(typeof result.result === 'string' ? parseJson(result.result) : result.result);
}

function storedCompressionContents(item: SkillReattachmentSourceItem): MessageContent[] {
  if (item.contentType !== 'application/vnd.limcode.compression-contents+json') return [];
  const envelope = asRecord(parseJson(item.content));
  if (envelope?.kind !== 'compression_contents' || !Array.isArray(envelope.contents)) return [];
  return envelope.contents.filter((value): value is MessageContent => {
    const record = asRecord(value);
    return !!record && (record.role === 'user' || record.role === 'model') && Array.isArray(record.parts);
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
