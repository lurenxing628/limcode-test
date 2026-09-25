/** Leads a first input that carries preloaded skills; the task prompt follows them unchanged. */
export const PRELOADED_SKILLS_HEADER = 'Skills preloaded by the parent agent for this task — follow them:';
/** Preloaded skill text a child's first input may carry; a spawn beyond it fails instead of truncating. */
export const MAX_PRELOADED_SKILL_BYTES = 256 * 1024;

const MANIFEST_PREFIX = '<!-- limcode-preloaded-skills ';
const MANIFEST_SUFFIX = ' -->';
const BLOCK_SEPARATOR = '\n\n';

/**
 * The child's first input: the header, a one-line manifest giving each skill's name and exact length,
 * the rendered skills, then the prompt. Reading it back follows the manifest's lengths, so no text in a
 * skill body or in the prompt (a literal `</skill>`, a copied header) can shift where a block ends.
 */
export function childInputWithPreloadedSkills(skillTexts: readonly string[], prompt: string): string {
  if (skillTexts.length === 0) return prompt;
  const manifest = skillTexts.map((text) => ({ name: /^<skill name="([^"]*)"/.exec(text)?.[1] ?? '', length: text.length }));
  return [
    `${PRELOADED_SKILLS_HEADER}\n${MANIFEST_PREFIX}${JSON.stringify(manifest)}${MANIFEST_SUFFIX}`,
    ...skillTexts,
    prompt
  ].join(BLOCK_SEPARATOR);
}

/**
 * The preloaded skill blocks of a child's first input and the task prompt after them; undefined for
 * input that is not exactly that shape. Each block is the skill as the child read it.
 */
export function splitPreloadedSkills(text: string): { skills: Array<{ name: string; text: string }>; prompt: string } | undefined {
  const lead = `${PRELOADED_SKILLS_HEADER}\n${MANIFEST_PREFIX}`;
  if (!text.startsWith(lead)) return undefined;
  const manifestEnd = text.indexOf(`${MANIFEST_SUFFIX}${BLOCK_SEPARATOR}`, lead.length);
  if (manifestEnd === -1) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text.slice(lead.length, manifestEnd));
  } catch {
    return undefined;
  }
  if (!Array.isArray(manifest) || manifest.length === 0) return undefined;
  let offset = manifestEnd + MANIFEST_SUFFIX.length + BLOCK_SEPARATOR.length;
  const skills: Array<{ name: string; text: string }> = [];
  for (const entry of manifest) {
    const record = entry !== null && typeof entry === 'object' ? entry as { name?: unknown; length?: unknown } : undefined;
    if (typeof record?.name !== 'string' || typeof record.length !== 'number' || !Number.isSafeInteger(record.length) || record.length < 0) {
      return undefined;
    }
    const block = text.slice(offset, offset + record.length);
    if (block.length !== record.length || text.slice(offset + record.length, offset + record.length + BLOCK_SEPARATOR.length) !== BLOCK_SEPARATOR) {
      return undefined;
    }
    skills.push({ name: record.name, text: block });
    offset += record.length + BLOCK_SEPARATOR.length;
  }
  return { skills, prompt: text.slice(offset) };
}

/**
 * The task a child input asks for, with its preloaded skill blocks reduced to their names, so task
 * previews and cards show what the child was asked to do rather than the first lines of a skill.
 * Text without preloaded skills is returned unchanged.
 */
export function childTaskTextForPreview(text: string): string {
  const split = splitPreloadedSkills(text);
  if (!split) return text;
  return `[skills: ${split.skills.map((skill) => skill.name).join(', ')}] ${split.prompt}`;
}
