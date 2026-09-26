import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { isPathBelow } from './path-containment.mjs';

export const INSTALLED_SMOKE_RECEIPT_KIND = 'limcode-installed-smoke-receipt';
export const INSTALLED_SMOKE_RECEIPT_REVISION = '2026-08-02';

const REQUIRED_RECOVERY_IDS = [
  'recovery.answer-inbox-invariant',
  'recovery.interrupted-subtree-incomplete',
  'recovery.delivery-pending',
  'recovery.effect-intent-hanging',
  'recovery.file-change-unresolved',
  'recovery.foreground-answer-wait-expired'
];
const CHECK_IDS = new Set([
  'package.smoke.open-extension',
  'package.smoke.send-message',
  'package.smoke.read-only-tool',
  'package.smoke.file-proposal-approve-apply',
  'package.smoke.command-run-and-wait',
  'package.smoke.subagent-start-and-cancel',
  'package.smoke.turn-interrupt',
  'package.smoke.extension-host-restart',
  'package.smoke.recovery-verification'
]);

export function createInstalledSmokeEvidence(options) {
  const receiptPath = absoluteFile(options.receiptPath, 'smoke receipt');
  const receipt = readJson(receiptPath, 'smoke receipt');
  assertPlainReceipt(receipt);
  const artifactPath = absoluteFile(options.artifactPath, 'VSIX artifact');
  const installedRoot = absoluteDirectory(options.installedRoot, 'installed root');
  const dataRoot = absoluteDirectory(options.dataRoot, 'installed data root');
  const workspaceRoot = absoluteDirectory(options.workspaceRoot, 'smoke workspace root');
  requireEqual(receipt.artifactSha256, sha256File(artifactPath), 'receipt artifactSha256');
  requireEqual(normalizedPath(receipt.extension.installedRoot), installedRoot, 'receipt extension.installedRoot');
  requireEqual(normalizedPath(receipt.runtime.dataRoot), dataRoot, 'receipt runtime.dataRoot');
  requireEqual(normalizedPath(receipt.workspace.root), workspaceRoot, 'receipt workspace.root');
  const databasePath = path.join(dataRoot, '.limcode-runtime', 'active', 'limcode.sqlite');
  if (!fs.existsSync(databasePath)) throw new Error(`installed Runtime database缺失：${databasePath}`);
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  return {
    receiptPath,
    receipt,
    artifactPath,
    installedRoot,
    dataRoot,
    workspaceRoot,
    databasePath,
    database,
    diagnostics: readDiagnostics(path.join(dataRoot, '.limcode-runtime', 'active', 'diagnostics')),
    close() { database.close(); }
  };
}

export function validateInstalledSmokeCheck(evidence, checkId) {
  if (!CHECK_IDS.has(checkId)) return `未知installed smoke check：${checkId}`;
  try {
    switch (checkId) {
      case 'package.smoke.open-extension': return checkOpenExtension(evidence);
      case 'package.smoke.send-message': return checkSendMessage(evidence);
      case 'package.smoke.read-only-tool': return checkReadOnlyTool(evidence);
      case 'package.smoke.file-proposal-approve-apply': return checkFileProposal(evidence);
      case 'package.smoke.command-run-and-wait': return checkCommand(evidence);
      case 'package.smoke.subagent-start-and-cancel': return checkChildCancel(evidence);
      case 'package.smoke.turn-interrupt': return checkTurnInterrupt(evidence);
      case 'package.smoke.extension-host-restart': return checkRestart(evidence);
      case 'package.smoke.recovery-verification': return checkRecovery(evidence);
      default: return `未实现installed smoke check：${checkId}`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkOpenExtension(evidence) {
  const { receipt, database, dataRoot, installedRoot } = evidence;
  if (!['WS', 'HTTP'].includes(receipt.browser.runtimeBadge)) throw new Error('Runtime徽标不是WS/HTTP');
  if (receipt.browser.reloadRequired !== false) throw new Error('Runtime徽标仍要求重载');
  if (receipt.browser.pageErrorCount !== 0) throw new Error('真实Workbench记录到pageerror');
  const manifest = readJson(path.join(installedRoot, 'package.json'), 'installed package manifest');
  requireEqual(`${manifest.publisher}.${manifest.name}`, receipt.extension.id, 'installed extension id');
  requireEqual(manifest.version, receipt.extension.version, 'installed extension version');
  const main = safeRelativePath(String(manifest.main ?? '').replace(/^\.\//, ''), 'installed main');
  requireEqual(receipt.extension.installedMainSha256, sha256File(path.join(installedRoot, main)), 'installed main digest');
  const binding = one(database, 'select data_set_id,root_instance_id,root_generation,pointer_revision,runtime_kernel_epoch from root_binding', [], 'RootBinding');
  assertBinding(binding, receipt.runtime.binding);
  if (!fs.existsSync(path.join(dataRoot, '.limcode-runtime', 'active', 'cas'))) throw new Error('当前CAS目录缺失');
  const schemaCount = scalar(database, 'select count(*) from schema_manifest');
  if (schemaCount < 60) throw new Error(`schema manifest领域数异常：${schemaCount}`);
  return null;
}

function checkSendMessage(evidence) {
  const turnId = requireId(evidence.receipt.facts.sendMessageTurnId, 'sendMessageTurnId');
  assertTurnTerminal(evidence.database, turnId, 'completed');
  const modelMessages = scalar(evidence.database, `
    select count(*) from message_turn_link mtl
    join message_current_revision_link current on current.message_id=mtl.message_id
    join message_revision revision on revision.id=current.revision_id
    where mtl.turn_id=? and revision.role='model'
  `, [turnId]);
  if (modelMessages !== 1) throw new Error(`普通消息Turn的assistant MessageRevision数量不是1：${modelMessages}`);
  return null;
}

function checkReadOnlyTool(evidence) {
  const { receipt, database, workspaceRoot } = evidence;
  const call = assertToolTerminal(database, receipt.facts.readOnlyToolCallId, 'read', 'succeeded');
  assertTurnTerminal(database, call.turn_id, 'completed');
  const target = inside(workspaceRoot, receipt.workspace.readOnlyTargetRelativePath, 'read-only target');
  const before = requireDigest(receipt.workspace.readOnlyDigestBefore, 'readOnlyDigestBefore');
  const after = requireDigest(receipt.workspace.readOnlyDigestAfter, 'readOnlyDigestAfter');
  requireEqual(before, after, 'read-only before/after digest');
  requireEqual(sha256File(target), after, 'read-only current target digest');
  if (scalar(database, 'select count(*) from file_change_set where tool_call_id=?', [call.id]) !== 0) {
    throw new Error('只读工具意外创建FileChangeSet');
  }
  return null;
}

function checkFileProposal(evidence) {
  const { receipt, database, workspaceRoot } = evidence;
  const call = assertToolTerminal(database, receipt.facts.fileToolCallId, 'write', 'succeeded');
  assertTurnTerminal(database, call.turn_id, 'completed');
  const changeSet = one(database, 'select id,status from file_change_set where tool_call_id=?', [call.id], 'FileChangeSet');
  requireEqual(changeSet.status, 'succeeded', 'FileChangeSet.status');
  const member = one(database, 'select id,operation,target_path,target_digest,target_content_object_id from file_change_set_member where change_set_id=?', [changeSet.id], 'FileChangeSetMember');
  requireEqual(member.target_path, receipt.workspace.fileTargetRelativePath, 'file target path');
  if (!member.target_content_object_id) throw new Error('FileChangeSetMember缺少target CAS对象');
  const decision = one(database, 'select decision from file_change_decision where change_set_id=?', [changeSet.id], 'FileChangeDecision');
  requireEqual(decision.decision, 'approved', 'FileChangeDecision.decision');
  const mutation = one(database, 'select id,outcome from file_mutation_receipt where change_set_id=?', [changeSet.id], 'FileMutationReceipt');
  requireEqual(mutation.outcome, 'succeeded', 'FileMutationReceipt.outcome');
  const mutationMember = one(database, 'select member_id,outcome,actual_digest from file_mutation_receipt_member where receipt_id=?', [mutation.id], 'FileMutationReceiptMember');
  requireEqual(mutationMember.member_id, member.id, 'mutation member identity');
  requireEqual(mutationMember.outcome, 'succeeded', 'FileMutationReceiptMember.outcome');
  const expected = requireDigest(receipt.workspace.fileTargetSha256, 'fileTargetSha256');
  requireEqual(member.target_digest, expected, 'target digest');
  requireEqual(mutationMember.actual_digest, expected, 'actual digest');
  requireEqual(sha256File(inside(workspaceRoot, member.target_path, 'file target')), expected, 'workspace file digest');
  return null;
}

function checkCommand(evidence) {
  const { receipt, database, dataRoot } = evidence;
  const call = assertToolTerminal(database, receipt.facts.commandToolCallId, 'bash', 'succeeded');
  assertTurnTerminal(database, call.turn_id, 'completed');
  const processId = requireId(receipt.facts.commandProcessId, 'commandProcessId');
  one(database, 'select id from process_origin_link where process_id=? and tool_call_id=?', [processId, call.id], 'ProcessOriginLink');
  const process = one(database, 'select status,retained_bytes,retained_chunks,dropped_bytes,truncated from process where id=?', [processId], 'Process');
  requireEqual(process.status, 'exited', 'Process.status');
  if (Number(process.retained_bytes) <= 0 || Number(process.retained_chunks) <= 0 || Number(process.dropped_bytes) !== 0 || Number(process.truncated) !== 0) {
    throw new Error('Process输出保留事实异常');
  }
  const receiptRow = one(database, 'select outcome,exit_code,exit_signal from process_receipt where process_id=?', [processId], 'ProcessReceipt');
  requireEqual(receiptRow.outcome, 'succeeded', 'ProcessReceipt.outcome');
  if (Number(receiptRow.exit_code) !== 0 || receiptRow.exit_signal !== null) throw new Error('Process真实退出码/信号异常');
  assertMarkerInSpool(dataRoot, processId, receipt.facts.commandOutputMarker);
  return null;
}

function checkChildCancel(evidence) {
  const { receipt, database } = evidence;
  const cancelledId = requireId(receipt.facts.cancelledChildExecutionId, 'cancelledChildExecutionId');
  const controlId = requireId(receipt.facts.controlChildExecutionId, 'controlChildExecutionId');
  if (cancelledId === controlId) throw new Error('取消目标与控制ChildExecution相同');
  const cancelled = one(database, 'select status from child_execution where id=?', [cancelledId], 'cancelled ChildExecution');
  requireEqual(cancelled.status, 'interrupting', 'cancelled ChildExecution.status');
  if (scalar(database, 'select count(*) from child_execution_active_turn_link where child_execution_id=?', [cancelledId]) !== 0) throw new Error('取消目标仍有ActiveTurnLink');
  const cancelledTurn = one(database, `select t.id,t.status,termination.terminal_status from child_execution_turn_link link join turn t on t.id=link.turn_id left join turn_termination termination on termination.turn_id=t.id where link.child_execution_id=? order by link.turn_seq desc limit 1`, [cancelledId], 'cancelled child Turn');
  requireEqual(cancelledTurn.status, 'terminated', 'cancelled child Turn.status');
  requireEqual(cancelledTurn.terminal_status, 'interrupted', 'cancelled child Turn terminal_status');
  assertNoLease(database, cancelledTurn.id);
  const control = one(database, 'select status from child_execution where id=?', [controlId], 'control ChildExecution');
  if (!['idle', 'terminated'].includes(control.status)) throw new Error(`控制ChildExecution状态异常：${control.status}`);
  const controlTurns = all(database, `select t.id,t.status,termination.terminal_status from child_execution_turn_link link join turn t on t.id=link.turn_id left join turn_termination termination on termination.turn_id=t.id where link.child_execution_id=?`, [controlId]);
  if (controlTurns.length === 0 || controlTurns.some((turn) => turn.status !== 'terminated' || turn.terminal_status !== 'completed')) {
    throw new Error('控制ChildExecution被取消目标误伤');
  }
  const interruptCall = assertToolTerminal(database, receipt.facts.childInterruptToolCallId, 'run_agent', 'succeeded');
  assertTurnTerminal(database, interruptCall.turn_id, 'completed');
  return null;
}

function checkTurnInterrupt(evidence) {
  const { receipt, database } = evidence;
  const turnId = requireId(receipt.facts.interruptedTurnId, 'interruptedTurnId');
  assertTurnTerminal(database, turnId, 'interrupted');
  if (scalar(database, 'select count(*) from tool_call where turn_id=?', [turnId]) !== 0) throw new Error('普通流式中断Turn包含ToolCall');
  const requestId = requireId(receipt.facts.interruptedModelRequestId, 'interruptedModelRequestId');
  const request = one(database, 'select status,terminal_state from model_request where id=? and turn_id=?', [requestId, turnId], 'interrupted ModelRequest');
  requireEqual(request.status, 'terminal', 'interrupted ModelRequest.status');
  if (typeof request.terminal_state !== 'string' || !request.terminal_state.trim()) throw new Error('ModelRequest缺少取消terminal_state');
  const checkpointCount = scalar(database, 'select count(*) from model_stream_checkpoint where model_request_id=?', [requestId]);
  if (checkpointCount < 1) throw new Error('普通Turn未真实流式产生checkpoint');
  if (receipt.facts.interruptCheckpointCountAtTerminal !== receipt.facts.interruptCheckpointCountAfterDelay) throw new Error('receipt显示迟到stream仍在增长');
  if (checkpointCount !== receipt.facts.interruptCheckpointCountAfterDelay) throw new Error('当前checkpoint数量与迟到窗口receipt不一致');
  return null;
}

function checkRestart(evidence) {
  const { receipt, diagnostics, dataRoot } = evidence;
  const restart = receipt.restart;
  const before = requireId(restart.hostBootIdBefore, 'hostBootIdBefore');
  const after = requireId(restart.hostBootIdAfter, 'hostBootIdAfter');
  if (before === after) throw new Error('Extension Host重启前后hostBootId相同');
  const beforeScans = recoveryEventsForHost(diagnostics, before);
  const afterScans = recoveryEventsForHost(diagnostics, after);
  assertRecoverySet(beforeScans, '重启前');
  assertRecoverySet(afterScans, '重启后');
  const restartedAt = Date.parse(requireIso(restart.restartedAt, 'restart.restartedAt'));
  const oldSessionId = requireId(restart.oldSessionId, 'oldSessionId');
  const newSessionId = requireId(restart.newSessionId, 'newSessionId');
  if (oldSessionId === newSessionId) throw new Error('重启前后Feed sessionId相同');
  const newKinds = new Set(diagnostics.filter((event) => event.metadata?.sessionId === newSessionId && Date.parse(event.observedAt) >= restartedAt).map((event) => event.eventKind));
  for (const kind of ['feed.data.posted', 'feed.data.acked', 'webview.feed.painted']) if (!newKinds.has(kind)) throw new Error(`新Feed session缺少${kind}`);
  if (diagnostics.some((event) => event.metadata?.sessionId === oldSessionId && Date.parse(event.observedAt) >= restartedAt)) {
    throw new Error('旧Feed session在新hostBoot后仍推进changes');
  }
  requireEqual(restart.rootBindingBeforeSha256, restart.rootBindingAfterSha256, 'restart RootBinding digest');
  requireEqual(sha256File(path.join(dataRoot, '.limcode-runtime', 'root-binding.json')), restart.rootBindingAfterSha256, 'current RootBinding digest');
  return null;
}

function checkRecovery(evidence) {
  const { receipt, database, diagnostics, dataRoot } = evidence;
  const hostBootId = requireId(receipt.restart.hostBootIdAfter, 'hostBootIdAfter');
  const events = recoveryEventsForHost(diagnostics, hostBootId);
  assertRecoverySet(events, '最终启动');
  const hanging = events.find((event) => event.correlationId === 'recovery.effect-intent-hanging');
  if (Number(hanging?.metadata?.reconciled ?? 0) < 1) throw new Error('最终启动未恢复任何异步Effect事实');
  const processId = requireId(receipt.facts.recoveryProcessId, 'recoveryProcessId');
  const process = one(database, 'select status,dropped_bytes,truncated from process where id=?', [processId], 'recovered Process');
  requireEqual(process.status, 'exited', 'recovered Process.status');
  if (Number(process.dropped_bytes) !== 0 || Number(process.truncated) !== 0) throw new Error('恢复进程输出发生丢弃或截断');
  const receipts = all(database, 'select outcome,exit_code,exit_signal from process_receipt where process_id=?', [processId]);
  if (receipts.length !== 1 || receipts[0].outcome !== 'succeeded' || Number(receipts[0].exit_code) !== 0 || receipts[0].exit_signal !== null) {
    throw new Error('异步进程恢复未形成唯一成功退出收据');
  }
  assertMarkerInSpool(dataRoot, processId, receipt.facts.recoveryOutputMarker);
  return null;
}

function assertToolTerminal(database, idInput, name, outcome) {
  const id = requireId(idInput, `${name} ToolCall id`);
  const call = one(database, 'select id,turn_id,tool_name,status from tool_call where id=?', [id], `${name} ToolCall`);
  requireEqual(call.tool_name, name, `${name} ToolCall.tool_name`);
  requireEqual(call.status, 'terminal', `${name} ToolCall.status`);
  const terminal = one(database, 'select status from tool_outcome where tool_call_id=?', [id], `${name} ToolOutcome`);
  requireEqual(terminal.status, outcome, `${name} ToolOutcome.status`);
  if (scalar(database, 'select count(*) from tool_model_result where tool_call_id=?', [id]) !== 1) throw new Error(`${name} ToolCall的ToolModelResult不是唯一一条`);
  return call;
}

function assertTurnTerminal(database, turnIdInput, status) {
  const turnId = requireId(turnIdInput, 'Turn.id');
  const turn = one(database, 'select status from turn where id=?', [turnId], 'Turn');
  requireEqual(turn.status, 'terminated', 'Turn.status');
  const termination = one(database, 'select terminal_status from turn_termination where turn_id=?', [turnId], 'TurnTermination');
  requireEqual(termination.terminal_status, status, 'TurnTermination.terminal_status');
  assertNoLease(database, turnId);
}

function assertNoLease(database, turnId) {
  if (scalar(database, 'select count(*) from execution_lease where turn_id=?', [turnId]) !== 0) throw new Error(`Turn ${turnId}仍有ExecutionLease`);
}

function recoveryEventsForHost(events, hostBootId) {
  return events.filter((event) => event.eventKind === 'recovery.scan.completed' && event.metadata?.hostBootId === hostBootId);
}

function assertRecoverySet(events, label) {
  const ids = [...new Set(events.map((event) => event.correlationId))].sort();
  if (JSON.stringify(ids) !== JSON.stringify([...REQUIRED_RECOVERY_IDS].sort())) throw new Error(`${label}recovery stable ID集合不完整：${ids.join(',')}`);
  if (events.some((event) => event.scopeKind !== 'runtime' || event.metadata?.status !== 'completed')) throw new Error(`${label}recovery事件缺少completed结论`);
}

function assertMarkerInSpool(dataRoot, processId, markerInput) {
  const marker = requireMarker(markerInput, `${processId} output marker`);
  const chunksRoot = path.join(
    dataRoot,
    '.limcode-runtime',
    'active',
    'process-spool',
    processId,
    'chunks'
  );
  const chunks = fs.readdirSync(chunksRoot).filter((name) => /-(?:stdout|stderr)\.bin$/.test(name)).sort();
  const bytes = Buffer.concat(chunks.map((name) => fs.readFileSync(path.join(chunksRoot, name))));
  const count = bytes.toString('utf8').split(marker).length - 1;
  if (count !== 1) throw new Error(`进程输出marker ${marker}出现${count}次，而不是1次`);
}

function readDiagnostics(root) {
  if (!fs.existsSync(root)) throw new Error(`diagnostics目录缺失：${root}`);
  const events = [];
  for (const name of fs.readdirSync(root).filter((entry) => entry.endsWith('.jsonl')).sort()) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line);
      if (event?.schema === 'limcode-reliable-diagnostic') events.push(event);
    }
  }
  return events.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || String(left.id).localeCompare(String(right.id)));
}

function assertBinding(actual, expected) {
  const fields = ['dataSetId', 'rootInstanceId', 'rootGeneration', 'pointerRevision', 'runtimeKernelEpoch'];
  const source = {
    dataSetId: actual.data_set_id,
    rootInstanceId: actual.root_instance_id,
    rootGeneration: Number(actual.root_generation),
    pointerRevision: Number(actual.pointer_revision),
    runtimeKernelEpoch: Number(actual.runtime_kernel_epoch)
  };
  for (const field of fields) requireEqual(source[field], expected[field], `RootBinding.${field}`);
}

function assertPlainReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('smoke receipt必须是JSON对象');
  requireEqual(receipt.kind, INSTALLED_SMOKE_RECEIPT_KIND, 'receipt.kind');
  requireEqual(receipt.contractRevision, INSTALLED_SMOKE_RECEIPT_REVISION, 'receipt.contractRevision');
  requireIso(receipt.createdAt, 'receipt.createdAt');
  for (const key of ['extension', 'runtime', 'browser', 'workspace', 'restart', 'facts']) {
    if (!receipt[key] || typeof receipt[key] !== 'object' || Array.isArray(receipt[key])) throw new Error(`receipt.${key}必须是对象`);
  }
  const stack = [{ value: receipt, label: 'receipt' }];
  while (stack.length) {
    const { value, label } = stack.pop();
    if (Array.isArray(value)) {
      value.forEach((entry, index) => stack.push({ value: entry, label: `${label}[${index}]` }));
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    for (const [key, entry] of Object.entries(value)) {
      if (/api.?key|authorization|password|secret|credential|headers|\benv\b/i.test(key)) throw new Error(`${label}.${key}是禁止的秘密字段`);
      stack.push({ value: entry, label: `${label}.${key}` });
    }
  }
}

function one(database, sql, params = [], label = 'row') {
  const rows = all(database, sql, params);
  if (rows.length !== 1) throw new Error(`${label}数量应为1，实际${rows.length}`);
  return rows[0];
}
function all(database, sql, params = []) { return database.prepare(sql).all(...params); }
function scalar(database, sql, params = []) {
  const row = database.prepare(sql).get(...params);
  if (!row) return 0;
  return Number(Object.values(row)[0]);
}
function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw new Error(`${label}不是有效JSON：${error instanceof Error ? error.message : String(error)}`); }
}
function absoluteFile(input, label) {
  const value = normalizedPath(input);
  if (!fs.existsSync(value) || !fs.statSync(value).isFile()) throw new Error(`${label}不存在或不是普通文件：${value}`);
  return value;
}
function absoluteDirectory(input, label) {
  const value = normalizedPath(input);
  if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) throw new Error(`${label}不存在或不是目录：${value}`);
  return value;
}
function normalizedPath(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error(`路径必须是绝对路径：${String(input)}`);
  return path.resolve(input);
}
function safeRelativePath(input, label) {
  if (typeof input !== 'string' || !input || path.isAbsolute(input) || input.split(/[\\/]+/).includes('..')) throw new Error(`${label}不是安全相对路径`);
  return input.split('/').join(path.sep);
}
function inside(root, relativeInput, label) {
  const relative = safeRelativePath(relativeInput, label);
  const target = path.resolve(root, relative);
  if (!isPathBelow(root, target)) throw new Error(`${label}逃逸workspace`);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`${label}不存在或不是文件`);
  return target;
}
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function requireDigest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label}不是SHA-256`);
  return value;
}
function requireId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error(`${label}无效`);
  return value.trim();
}
function requireMarker(value, label) {
  if (typeof value !== 'string' || !/^[A-Z0-9_\-]{4,96}$/.test(value)) throw new Error(`${label}无效`);
  return value;
}
function requireIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label}不是ISO时间`);
  return value;
}
function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}不一致：${String(actual)} != ${String(expected)}`);
}
