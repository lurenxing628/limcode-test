import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const { CROSS_CONVERSATION_TOOL_NAMES, crossConversationToolModules, isReadonlyCrossConversationTool } =
  load('backend/world/modules/tools/definitions/crossConversation/index.js');
const { runAgentTool, CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY } = load('backend/world/modules/tools/definitions/runAgent/index.js');
const { createBuiltinToolDefinitions } = load('backend/world/modules/tools/definitions/index.js');
const { CROSS_CONVERSATION_LIMITS, frozenCrossConversationEnabled } = load('backend/reliableKernel/collaborationPolicy.js');
const { RELIABLE_KERNEL_COLLABORATION_TEXT_PREVIEW_MAX_CHARACTERS } = load('shared/reliableKernelClientFeed.js');
const { crossConversationToolPermitted } = load('shared/toolPolicyResolution.js');

const contract = async name => JSON.parse(await fs.readFile(`docs/architecture/reliable-kernel/contracts/${name}.json`, 'utf8'));
const crossConversation = async () => (await contract('subagent')).collaboration.crossConversation;

test('the cross-conversation contract names exactly the tools the code declares, with the same read-only split', async () => {
  const section = await crossConversation();
  const declarations = crossConversationToolModules.map(module => module.create({}).declaration);
  assert.deepEqual(section.tools, [...CROSS_CONVERSATION_TOOL_NAMES]);
  assert.deepEqual(declarations.map(declaration => declaration.name), [...CROSS_CONVERSATION_TOOL_NAMES]);
  assert.deepEqual(section.readonlyTools, CROSS_CONVERSATION_TOOL_NAMES.filter(isReadonlyCrossConversationTool));
  assert.deepEqual(section.readonlyTools, declarations.filter(declaration => declaration.metadata.readonly === true).map(declaration => declaration.name));
  // "send-type-tools-auto-approved-by-default": no declaration opts out of automatic approval.
  assert.match(section.approval, /^send-type-tools-auto-approved-by-default;/);
  for (const declaration of declarations) assert.equal(declaration.metadata.defaultAutoApproveExecution, undefined, declaration.name);
  const builtin = createBuiltinToolDefinitions({ command: { toolName: 'bash', description: 'contract fixture' } }).map(tool => tool.declaration.name);
  for (const name of CROSS_CONVERSATION_TOOL_NAMES) assert.ok(builtin.includes(name), `${name} is registered`);
});

test('without run_agent the code permits exactly the contract read-only pair, as the allowlist rule says', async () => {
  const section = await crossConversation();
  assert.match(section.allowlist, /; send-create-and-fork-are-offered-and-admitted-only-while-the-Turn-effective-allowedTools-include-run_agent\(otherwise-list-and-read-only\);/);
  const withoutRunAgent = [...CROSS_CONVERSATION_TOOL_NAMES];
  assert.deepEqual(CROSS_CONVERSATION_TOOL_NAMES.filter(name => crossConversationToolPermitted(withoutRunAgent, name)), section.readonlyTools);
  assert.deepEqual(CROSS_CONVERSATION_TOOL_NAMES.filter(name => crossConversationToolPermitted(new Set(['run_agent']), name)), section.tools);
});

test('the switch contract matches the run_agent config schema: boolean, default off, defaultValue only, fail closed', async () => {
  const section = await crossConversation();
  assert.ok(section.switch.startsWith(`ToolPolicy.toolConfigs.run_agent.config.${CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY};`));
  const field = runAgentTool.declaration.configSchema.fields.find(candidate => candidate.key === CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY);
  assert.equal(field.type, 'boolean');
  assert.equal(field.defaultValue, false);
  assert.match(section.switch, /; boolean; default-off;/);
  assert.equal(CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY in runAgentTool.declaration.defaultConfig, false);
  assert.match(section.switch, /configSchema-defaultValue-only/);
  assert.match(section.switch, /non-boolean-fails-closed/);
  const frozen = value => ({ toolPolicy: { toolConfigs: { run_agent: { config: { [CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY]: value } } } } });
  assert.equal(frozenCrossConversationEnabled({}), false);
  assert.equal(frozenCrossConversationEnabled(frozen('true')), false);
  assert.equal(frozenCrossConversationEnabled(frozen(true)), true);
});

test('the limits contract carries the fixed limits the control plane enforces', async () => {
  const { limits } = await crossConversation();
  assert.equal(limits.maxPendingInboundMessages, CROSS_CONVERSATION_LIMITS.maxPendingInboundMessages);
  assert.equal(limits.maxConversationSpawnsPerTurn, CROSS_CONVERSATION_LIMITS.maxConversationSpawnsPerTurn);
  assert.deepEqual(Object.keys(CROSS_CONVERSATION_LIMITS).sort(), ['maxConversationSpawnsPerTurn', 'maxPendingInboundMessages']);
  const document = await fs.readFile('docs/architecture/reliable-kernel/agent-collaboration.md', 'utf8');
  assert.match(document, new RegExp(`最多积压 ${CROSS_CONVERSATION_LIMITS.maxPendingInboundMessages} 条`));
  assert.match(document, new RegExp(`合计最多 ${CROSS_CONVERSATION_LIMITS.maxConversationSpawnsPerTurn} 次`));
});

test('the client feed contract preview bound matches the projection constant', async () => {
  const projection = (await contract('client-feed')).collaborationProjection;
  const bound = RELIABLE_KERNEL_COLLABORATION_TEXT_PREVIEW_MAX_CHARACTERS;
  assert.match(projection.messagePreview, new RegExp(`text_preview-of-at-most-${bound}-characters`));
  assert.match(projection.runtimeContinuationPreview, new RegExp(`${bound}-character-text-preview`));
  assert.equal(projection.messageBodiesInFeed, false);
});

test('the board contract says it is not offered, and the registry agrees', async () => {
  const { collaboration } = await contract('subagent');
  assert.match(collaboration.board.offering, /^not-offered-to-models-in-phase-one;/);
  const builtin = createBuiltinToolDefinitions({ command: { toolName: 'bash', description: 'contract fixture' } }).map(tool => tool.declaration.name);
  assert.equal(builtin.includes('agent_board'), false);
});
