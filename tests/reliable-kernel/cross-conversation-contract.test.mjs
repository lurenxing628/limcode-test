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
const { COLLABORATION_MESSAGE_MAX_TEXT_BYTES, COLLABORATION_TEXT_PAGE_TOKENS, COLLABORATION_TEXT_PAGE_MAX_CHARACTERS,
  TRANSCRIPT_PAGE_TOKENS, TRANSCRIPT_MESSAGE_PREVIEW_TOKENS, CROSS_PROJECT_REFUSAL } = load('backend/reliableKernel/collaborationControlPlane.js');
const { TOOL_RESULT_MAX_TOKENS } = load('backend/reliableKernel/modelFacingContextProjection.js');
const { RUNTIME_DELIVERY_MODEL_NOTE, renderRuntimeDeliveryModelEnvelope } = load('backend/reliableKernel/runtimeDeliveryProjection.js');
const { agentCollaborationToolModules, AGENT_COLLABORATION_TOOL_NAMES } = load('backend/world/modules/tools/definitions/agentCollaboration/index.js');
const { RELIABLE_KERNEL_COLLABORATION_TEXT_PREVIEW_MAX_CHARACTERS } = load('shared/reliableKernelClientFeed.js');
const { crossConversationToolPermitted, resolveToolPolicyLayers, toolAllowedByPolicy } = load('shared/toolPolicyResolution.js');
const { CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE, CLIENT_MESSAGE_WINDOW_LIMIT, CLIENT_SNAPSHOT_MAX_BYTES } = load('backend/reliableKernel/clientFeedBounds.js');

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

test('the switch is the grant and without run_agent the code permits exactly the contract read-only pair, as the allowlist rule says', async () => {
  const section = await crossConversation();
  assert.match(section.allowlist, /^the-switch-is-the-grant; the-Turn-frozen-switch-alone-offers-and-admits-the-five-tools-in-top-level-conversations;/);
  assert.match(section.allowlist, /; send-create-and-fork-only-while-the-Turn-effective-allowedTools-include-run_agent\(otherwise-list-and-read-only\);/);
  assert.match(section.allowlist, /; no-tool-list-controls-them-and-their-names-in-saved-lists-are-ignored-/);
  const withoutRunAgent = [...CROSS_CONVERSATION_TOOL_NAMES];
  assert.deepEqual(CROSS_CONVERSATION_TOOL_NAMES.filter(name => crossConversationToolPermitted(withoutRunAgent, name)), section.readonlyTools);
  assert.deepEqual(CROSS_CONVERSATION_TOOL_NAMES.filter(name => crossConversationToolPermitted(new Set(['run_agent']), name)), section.tools);
  const on = { run_agent: { config: { crossConversationCollaboration: true } } };
  const off = { run_agent: { config: { crossConversationCollaboration: false } } };
  const admitted = policy => CROSS_CONVERSATION_TOOL_NAMES.filter(name => toolAllowedByPolicy(policy, { name }));
  assert.deepEqual(admitted({ allowedTools: ['run_agent'], toolConfigs: on }), section.tools, 'a list naming none of them');
  assert.deepEqual(admitted({ allowedTools: [], toolConfigs: on }), section.readonlyTools);
  assert.deepEqual(admitted({ allowedTools: ['run_agent', ...CROSS_CONVERSATION_TOOL_NAMES], toolConfigs: off }), [], 'a list naming all of them');
  assert.deepEqual(resolveToolPolicyLayers([{ scopeKind: 'global', policy: { allowedTools: ['read', ...CROSS_CONVERSATION_TOOL_NAMES] } }], []).allowedTools, ['read'],
    'their names in a saved list are ignored');
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

test('the message size contract and document carry the byte cap the control plane enforces', async () => {
  const { messageText } = (await contract('subagent')).collaboration;
  assert.equal(messageText.maxBytes, COLLABORATION_MESSAGE_MAX_TEXT_BYTES);
  assert.match(messageText.rule, /^every-collaboration-message-body-is-1-to-maxBytes-UTF-8-bytes; a-longer-send-is-refused-and-writes-nothing;/);
  const document = await fs.readFile('docs/architecture/reliable-kernel/agent-collaboration.md', 'utf8');
  assert.match(document, new RegExp(`正文为 1 到 ${COLLABORATION_MESSAGE_MAX_TEXT_BYTES} 个 UTF-8 字节`));
});

test('the client feed contract preview bound matches the projection constant', async () => {
  const projection = (await contract('client-feed')).collaborationProjection;
  const bound = RELIABLE_KERNEL_COLLABORATION_TEXT_PREVIEW_MAX_CHARACTERS;
  assert.match(projection.messagePreview, new RegExp(`text_preview-of-at-most-${bound}-characters`));
  assert.match(projection.runtimeContinuationPreview, new RegExp(`${bound}-character-text-preview`));
  assert.equal(projection.messageBodiesInFeed, false);
});

test('the client feed contract snapshot numbers are the code constants the projection uses', async () => {
  const client = await contract('client-feed');
  // queryCollaborationMessagesForTurns limits the collaboration selection by the per-type bound.
  assert.match(client.collaborationProjection.snapshotSelection, new RegExp(`; at-most-${CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE}-newest-by-message_seq$`));
  assert.equal(client.snapshot.activeRecordLimitPerType, CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE);
  assert.equal(client.snapshot.messageWindowLimit, CLIENT_MESSAGE_WINDOW_LIMIT);
  // enforceSnapshotBounds trims to this byte limit; the collaboration trimming rule refers to it.
  assert.equal(client.snapshot.maxBytes, CLIENT_SNAPSHOT_MAX_BYTES);
  assert.match(client.collaborationProjection.byteLimitTrim, /-trimmed-under-snapshot-maxBytes-/);
});

test('the board contract says it is not offered, and the registry agrees', async () => {
  const { collaboration } = await contract('subagent');
  assert.match(collaboration.board.offering, /^not-offered-to-models-in-phase-one;/);
  const builtin = createBuiltinToolDefinitions({ command: { toolName: 'bash', description: 'contract fixture' } }).map(tool => tool.declaration.name);
  assert.equal(builtin.includes('agent_board'), false);
});

test('paged reads: the contract numbers are the code constants, every page fits under the tool-result cap, and the truncation marker names the paged tool', async () => {
  const { messageText } = (await contract('subagent')).collaboration;
  assert.equal(messageText.pageTokens, COLLABORATION_TEXT_PAGE_TOKENS);
  assert.equal(messageText.pageMaxCharacters, COLLABORATION_TEXT_PAGE_MAX_CHARACTERS);
  assert.ok(COLLABORATION_TEXT_PAGE_TOKENS < TOOL_RESULT_MAX_TOKENS);
  const { readBudget } = await crossConversation();
  assert.deepEqual(readBudget, { pageTokens: TRANSCRIPT_PAGE_TOKENS, messagePreviewTokens: TRANSCRIPT_MESSAGE_PREVIEW_TOKENS });
  assert.ok(TRANSCRIPT_MESSAGE_PREVIEW_TOKENS <= TRANSCRIPT_PAGE_TOKENS && TRANSCRIPT_PAGE_TOKENS < TOOL_RESULT_MAX_TOKENS);
  // The paging tool the contract and the marker name is a real team tool with the parameters they name.
  const pagingTool = /^(read_agent_messages)-with-M#-messageRef-and-offset/.exec(messageText.paging)?.[1];
  assert.ok(AGENT_COLLABORATION_TOOL_NAMES.includes(pagingTool));
  const properties = name => [...agentCollaborationToolModules, ...crossConversationToolModules].map(module => module.create({}).declaration)
    .find(declaration => declaration.name === name).parameters.properties;
  for (const key of ['messageRef', 'offset']) {
    assert.ok(properties(pagingTool)[key], `${pagingTool}.${key}`);
    assert.ok(properties('read_conversation')[key], `read_conversation.${key}`);
  }
  const catalog = { entries: [{ kind: 'collaborationMessage', ref: 'M1', target: 'message-one' },
    { kind: 'conversation', ref: 'C1', target: 'sender' }, { kind: 'conversation', ref: 'C2', target: 'recipient' }] };
  const rendered = renderRuntimeDeliveryModelEnvelope({ kind: 'collaboration_message', sourceId: 'message-one', messageId: 'message-one',
    deliveryId: 'delivery', inboxItemId: 'inbox', targetTurnId: 'turn', status: 'submitted', deliveredAt: '2026-09-23T00:00:00.000Z',
    note: RUNTIME_DELIVERY_MODEL_NOTE, sourceConversationId: 'sender', targetConversationId: 'recipient', sourceKind: 'tool', mode: 'followup',
    delivery: 'followup_task', senderKind: 'other_conversation', senderTitle: 'Sender',
    replyToMessageId: null, content: 'long task. '.repeat(4000) }, undefined, catalog);
  assert.match(rendered, new RegExp(`${pagingTool} with messageRef=M1 and offset=0`));
  assert.match(messageText.preview, new RegExp(`marker-names-the-exact-call-${pagingTool}-with-messageRef-and-offset=0`));
  const document = await fs.readFile('docs/architecture/reliable-kernel/agent-collaboration.md', 'utf8');
  assert.match(document, new RegExp(`至多 ${COLLABORATION_TEXT_PAGE_TOKENS} 个估算 token（\`COLLABORATION_TEXT_PAGE_TOKENS\`）和 ${COLLABORATION_TEXT_PAGE_MAX_CHARACTERS} 个字符`));
  assert.match(document, new RegExp(`条目合计至多 ${TRANSCRIPT_PAGE_TOKENS} 个估算 token（\`TRANSCRIPT_PAGE_TOKENS\`），单条至多 ${TRANSCRIPT_MESSAGE_PREVIEW_TOKENS}`));
  assert.match(document, new RegExp(`低于 ${TOOL_RESULT_MAX_TOKENS} token 的工具结果上限`));
});

test('the project scope contract matches the refusal the control plane gives and the texts models and users read', async () => {
  const section = await crossConversation();
  assert.match(section.targets, /^other-active-top-level-conversations-of-the-caller-project-by-ConversationProjectLink; conversations-without-a-project-reach-only-each-other;/);
  assert.match(CROSS_PROJECT_REFUSAL, /different project/);
  assert.match(CROSS_PROJECT_REFUSAL, /without a project only reach each other/);
  const declarations = crossConversationToolModules.map(module => module.create({}).declaration);
  assert.doesNotMatch(declarations.map(declaration => declaration.description).join('\n'), /workspace/);
  assert.match(declarations.find(declaration => declaration.name === 'list_conversations').description, /this conversation's project/);
  const field = runAgentTool.declaration.configSchema.fields.find(candidate => candidate.key === CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY);
  assert.match(field.description, /同一项目/);
  assert.doesNotMatch(field.description, /工作区/);
  const document = await fs.readFile('docs/architecture/reliable-kernel/agent-collaboration.md', 'utf8');
  assert.match(document, /### 项目范围（已定）/);
  assert.match(document, /未绑定项目的对话.*只与其他未绑定的对话互通/);
});
