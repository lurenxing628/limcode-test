# 本项目源码证据

基线：`11ce63e195c667c78154e8560e598a1024f69b01`。仅截取源码，不包含用户数据。

## AGENTS.md:11

```text
11: ### 1.0 兼容原则
12: 
13: 当前项目仍然处于开发模式，因此不要对旧格式有任何兜底，也不需要保留旧功能代码的兼容和体验，也不需要写什么协议v1，v2等之类的运行时内部版本号，全面使用新格式新功能更优秀的代码。
14: 
15: 允许机器合同使用日期化`planRevision/contractRevision`、密码学domain separator或单一Runtime schema epoch来标识当前定义；这些标识不得用于运行时版本协商、旧格式fallback或维护未发布格式的通用 migration 链。当前 Runtime epoch 为 5。为保留已发布用户的对话，精确支持版本 0.0.10–0.0.14 的 epoch 3 和 0.0.15–0.0.21 的 epoch 4 离线升级到 epoch 5：数据库打开前核对完整 table/index/trigger/manifest/RootBinding 指纹，要求其它 Host 离线，使用 SQLite Backup API 持久备份，通过 pending pointer、单事务和 durable journal 向前恢复；旧版中断的 3→4 pending/journal 经精确核验后先收敛；原 Conversation、Message、附件与 CAS 保留。epoch 3 的旧 Child Runtime continuation、epoch 4 精确缺少 RuntimeDeliveryIntentLink 的前驱，仅在身份与内容全部严格匹配时转换。不允许由其它缺表、字段或 digest 推导前驱。未知结构漂移和不受支持的旧 epoch 保持原根不变并 fail closed，绝不自动换成空库；用户显式归档重置另走独立入口。当前 epoch 内任何 table/index/trigger/manifest/RootBinding 漂移也 fail closed，不补表、不修 metadata。
16: 
17: ### 1.1 独立领域对象必须独立建模
18: 
19: 如果两个概念可以独立存在、独立复用、独立存储，就不要把一个塞进另一个对象里。
20: 
```

## backend/reliableKernel/databaseSchema.ts:33

```text
33: export function configureWriterConnection(database: Database.Database): void {
34:   database.defaultSafeIntegers(true);
35:   database.pragma('journal_mode = WAL');
36:   database.pragma('synchronous = NORMAL');
37:   database.pragma('foreign_keys = ON');
38:   database.pragma('busy_timeout = 5000');
39: }
40: 
41: export function configureReaderConnection(database: Database.Database): void {
42:   database.defaultSafeIntegers(true);
43:   database.pragma('foreign_keys = ON');
44:   database.pragma('busy_timeout = 5000');
45: }
```

## backend/reliableKernel/databaseWorker.ts:193

```text
193:   const writer = new Database(toSqliteFilePath(data.binding.paths.databasePath), { fileMustExist: true });
194:   configureWriterConnection(writer);
195:   assertCurrentSchema(writer, data.binding);
196:   configureTransactionChangeCapture(writer);
197:   const reader = new Database(toSqliteFilePath(data.binding.paths.databasePath), { readonly: true, fileMustExist: true });
198:   configureReaderConnection(reader);
199:   let commitSeq = 0n;
200:   let closed = false;
201:   const contextCasCache = new VerifiedContextCasCache();
202:   const conversationRuntimeWork = createConversationRuntimeWorkProbe(reader);
203: 
204:   post({ type: 'ready', workerThreadId: threadId, mode: data.mode });
205:   port.on('message', (request: DatabaseWorkerRequest) => {
206:     if (closed) return;
207:     const receivedAtMs = Number.isFinite(request.metricEnqueuedAtMs)
208:       ? performance.now()
209:       : undefined;
210:     const respond = (
211:       response: Extract<DatabaseWorkerResponse, { type: 'response' }>,
212:       transferList: readonly ArrayBuffer[] = []
213:     ) => postMeasuredResponse(response, request.metricEnqueuedAtMs, receivedAtMs, transferList);
214:     try {
215:       if (request.kind === 'transaction') {
216:         assertDatabaseBinding(writer, data.binding);
217:         const result = executeTransaction(writer, request.steps, commitSeq + 1n);
218:         commitSeq += 1n;
219:         post({ type: 'commit', result });
220:         respond({ type: 'response', id: request.id, ok: true, result });
```

## backend/reliableKernel/databaseWorker.ts:392

```text
392: function configureTransactionChangeCapture(database: Database.Database): void {
393:   database.exec(`
394:     CREATE TEMP TABLE runtime_transaction_change (
395:       sequence INTEGER PRIMARY KEY,
396:       domain TEXT NOT NULL,
397:       id TEXT NOT NULL,
398:       kind TEXT NOT NULL CHECK (kind IN ('upsert', 'remove'))
399:     )
400:   `);
401:   for (const schema of DOMAIN_REPOSITORIES.all().map((repository) => repository.schema)) {
402:     if (schema.client === 'none') continue;
403:     const domain = sqlText(schema.key);
404:     for (const operation of ['insert', 'update', 'delete'] as const) {
405:       const row = operation === 'delete' ? 'OLD' : 'NEW';
406:       const kind = operation === 'delete' ? 'remove' : 'upsert';
407:       database.exec(`
408:         CREATE TEMP TRIGGER ${quote(`capture_${schema.table}_${operation}`)}
409:         AFTER ${operation.toUpperCase()} ON ${quote(schema.table)}
410:         BEGIN
411:           INSERT INTO runtime_transaction_change (domain, id, kind)
412:           VALUES (${domain}, ${row}.id, '${kind}');
413:         END
414:       `);
```

## backend/reliableKernel/databaseWorker.ts:616

```text
616: function executeTransaction(
617:   database: Database.Database,
618:   steps: RepositoryTransactionStep[],
619:   nextCommitSeq: bigint
620: ): RuntimeCommitResult {
621:   if (!Array.isArray(steps) || steps.length === 0) throw new Error('Runtime transaction requires at least one Repository step.');
622:   const allocatedSequences: RuntimeAllocatedSequence[] = [];
623:   let changes: RuntimeChange[] = [];
624:   database.exec('BEGIN IMMEDIATE');
625: 
626:   try {
627:     database.exec('DELETE FROM temp.runtime_transaction_change');
628:     executeSteps(database, steps, allocatedSequences);
629:     assertTouchedRuntimeAggregates(database, steps);
630:     changes = readTransactionChanges(database);
631:     database.exec('COMMIT');
632:   } catch (error) {
633:     database.exec('ROLLBACK');
634:     throw error;
635:   }
636:   return { commitSeq: nextCommitSeq.toString(), changes, allocatedSequences };
637: }
```

## backend/reliableKernel/databaseWorker.ts:1639

```text
1639:     terminal?.model_request_id !== modelRequestId
1640:     || terminal.attempt_seq !== mutation.attemptSeq
1641:     || terminal.socket_generation !== mutation.socketGeneration
1642:     || terminal.checkpoint_kind !== 'terminal_summary'
1643:   ) throw new Error('ModelStream checkpoint prune requires the matching terminal summary.');
1644:   const retained = database.prepare(`
1645:     SELECT id
1646:       FROM model_stream_checkpoint
1647:      WHERE model_request_id = ?
1648:        AND attempt_seq = ?
1649:        AND socket_generation = ?
1650:        AND checkpoint_kind != 'terminal_summary'
1651:      ORDER BY stream_seq DESC
1652:      LIMIT ?
1653:   `).all(
1654:     modelRequestId,
1655:     mutation.attemptSeq,
1656:     mutation.socketGeneration,
1657:     BigInt(MODEL_STREAM_TERMINAL_TAIL)
1658:   ) as Array<{ id: string }>;
1659:   const keep = new Set([terminalCheckpointId, ...retained.map((row) => requireRuntimeId(row.id))]);
1660:   const obsolete = database.prepare(
1661:     'SELECT id FROM model_stream_checkpoint WHERE model_request_id = ?'
1662:   ).all(modelRequestId) as Array<{ id: string }>;
1663:   const deleteStatement = database.prepare('DELETE FROM model_stream_checkpoint WHERE id = ?');
1664:   for (const row of obsolete) {
1665:     const id = requireRuntimeId(row.id);
1666:     if (!keep.has(id)) deleteStatement.run(id);
```

## backend/reliableKernel/schema/domainManifest.ts:154

```text
154: function validateDomainManifest(): void {
155:   if (RUNTIME_DOMAIN_SCHEMAS.length !== 107) {
156:     throw new Error(`Runtime domain schema exact set must contain 107 entries, found ${RUNTIME_DOMAIN_SCHEMAS.length}.`);
157:   }
158:   for (const field of ['key', 'table', 'repository', 'codec'] as const) {
159:     const values = RUNTIME_DOMAIN_SCHEMAS.map((entry) => entry[field]);
160:     if (new Set(values).size !== values.length) throw new Error(`Duplicate Runtime domain ${field}.`);
161:   }
162:   const forbidden = new Set([
163:     'child_turn_link',
164:     'provider_continuation',
165:     'client_change_log',
166:     'ask_user',
167:     'task_list',
168:     'mcp',
169:     'runtime_record',
170:     'domain_json'
171:   ]);
172:   for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
173:     if (forbidden.has(schema.table)) throw new Error(`Forbidden Runtime table: ${schema.table}`);
174:     if (schema.columns[0]?.name !== 'id' || schema.columns[0]?.type !== 'TEXT') {
175:       throw new Error(`Runtime domain table requires a TEXT id primary key: ${schema.table}`);
```

## backend/reliableKernel/clientFeed.ts:986

```text
986:   private async ensureExternalCommitPolling(): Promise<void> {
987:     if (this.externalPollTimer) return;
988:     if (!this.externalPollInitialization) {
989:       this.externalPollInitialization = (async () => {
990:         this.externalDataVersion = await this.database.externalDataVersion();
991:         if (this.sessions.size === 0 || this.externalPollTimer) return;
992:         this.externalPollTimer = setInterval(() => {
993:           void this.pollExternalCommits();
994:         }, 1_000);
995:         this.externalPollTimer.unref();
996:       })().finally(() => {
997:         this.externalPollInitialization = null;
998:       });
999:     }
1000:     await this.externalPollInitialization;
1001:   }
1002: 
1003:   private async pollExternalCommits(): Promise<void> {
1004:     if (this.externalPollInFlight || this.sessions.size === 0) return;
1005:     this.externalPollInFlight = true;
1006:     try {
1007:       const nextVersion = await this.database.externalDataVersion();
1008:       if (this.externalDataVersion === null) {
1009:         this.externalDataVersion = nextVersion;
1010:         return;
1011:       }
1012:       if (nextVersion === this.externalDataVersion) return;
1013:       this.externalDataVersion = nextVersion;
1014:       for (const session of this.sessions.values()) this.enterSnapshotRequired(session);
1015:     } catch (error) {
1016:       for (const session of [...this.sessions.values()]) this.closeFailedSession(session, error);
1017:     } finally {
1018:       this.externalPollInFlight = false;
1019:     }
```

## backend/reliableKernel/clientProjection.ts:667

```text
667: export function executeClientProjectionSnapshot(
668:   database: Database.Database,
669:   activeConversationId: string | null,
670:   commitSeq: bigint,
671:   content: ClientProjectionContentAccess
672: ): SnapshotBarrier<ClientProjectionSnapshot> {
673:   const conversationId = activeConversationId === null ? null : requireRuntimeId(activeConversationId);
674:   database.exec('BEGIN');
675:   try {
676:     const conversations = queryPlainRows(database, `
677:       SELECT id, title, status, created_at, updated_at
678:         FROM conversation
679:        ORDER BY updated_at DESC, id DESC
680:        LIMIT @limit
681:     `, { limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) });
682:     const emptyWindow = {
683:       conversationId,
684:       messages: [],
685:       visibleMessageCount: '0',
686:       lastMessageSeq: '0',
```

## backend/reliableKernel/clientProjection.ts:1618

```text
1618:   if (input.scopeKind === 'project' && !input.projectFolderUri?.trim()) {
1619:     throw new TypeError('Project conversation history requires projectFolderUri.');
1620:   }
1621:   const dataVersion = BigInt(database.pragma('data_version', { simple: true }) as number | bigint);
1622:   const snapshotCommitSeq = `${commitSeq.toString()}:${dataVersion.toString()}`;
1623:   const cursorReset = input.expectedCommitSeq !== undefined && input.expectedCommitSeq !== snapshotCommitSeq;
1624:   const useCursor = !cursorReset && input.afterUpdatedAt !== undefined;
1625:   const scope = conversationHistoryScopeSql(input, 'conversation');
1626:   const cursorSql = useCursor
1627:     ? `AND (conversation.updated_at < @afterUpdatedAt
1628:          OR (conversation.updated_at = @afterUpdatedAt AND conversation.id < @afterId))`
1629:     : '';
1630:   database.exec('BEGIN');
1631:   try {
1632:     const seedCandidates = queryPlainRows(database, `
1633:       SELECT conversation.id, conversation.title, conversation.status,
1634:              conversation.created_at, conversation.updated_at
1635:         FROM conversation
1636:        WHERE ${scope.sql}
1637:              ${cursorSql}
1638:        ORDER BY conversation.updated_at DESC, conversation.id DESC
1639:        LIMIT @seedLimit
1640:     `, {
1641:       ...scope.params,
1642:       ...(useCursor ? { afterUpdatedAt: input.afterUpdatedAt!, afterId: input.afterId! } : {}),
1643:       seedLimit: BigInt(input.limit + 1)
1644:     });
1645:     const hasMore = seedCandidates.length > input.limit;
1646:     const seedRows = seedCandidates.slice(0, input.limit);
1647:     const totalRow = database.prepare(`
1648:       SELECT COUNT(*) AS total FROM conversation WHERE ${scope.sql}
1649:     `).get(scope.params) as { total: bigint };
```

## backend/reliableKernel/clientProjection.ts:1758

```text
1758: function conversationHistoryScopeSql(
1759:   input: ConversationHistoryProjectionInput,
1760:   alias: string
1761: ): { sql: string; params: Record<string, string> } {
1762:   if (input.scopeKind === 'all') return { sql: '1 = 1', params: {} };
1763:   if (input.scopeKind === 'unbound') {
1764:     return {
1765:       sql: `NOT EXISTS (
1766:         SELECT 1 FROM conversation_project_link AS scope_link
1767:          WHERE scope_link.conversation_id = ${alias}.id AND scope_link.role = 'primary'
1768:       )`,
1769:       params: {}
1770:     };
1771:   }
1772:   return {
1773:     sql: `EXISTS (
1774:       SELECT 1
1775:         FROM conversation_project_link AS scope_link
1776:         JOIN project_context AS scope_project ON scope_project.id = scope_link.project_context_id
1777:        WHERE scope_link.conversation_id = ${alias}.id
1778:          AND scope_link.role = 'primary'
1779:          AND scope_project.uri = @projectFolderUri
1780:     )`,
1781:     params: { projectFolderUri: input.projectFolderUri!.trim() }
1782:   };
1783: }
1784: 
```

## backend/reliableKernel/runtimeApplication.ts:426

```text
426:   /** External SQLite commits do not arrive through this host's onCommit listener. */
427:   public async refreshExternalRuntimeWork(): Promise<void> {
428:     if (this.convergenceClosed) return;
429:     this.scheduleRuntimeConvergence();
430:     await this.database.conversationOwners.sweepIdle();
```

## backend/reliableKernel/runtimeApplication.ts:476

```text
476:   private async runRuntimeConvergence(): Promise<void> {
477:     this.convergenceRequested = false;
478:     let failed = 0;
479:     try {
480:       const pendingFileMutations = await listAllDomainRows(this.database, 'EffectIntent', {
481:         effect_kind: 'file_mutation',
482:         dispatch_state: 'pending'
483:       });
484:       for (const intent of pendingFileMutations) {
485:         try {
486:           await this.convergeOwnedEffect(String(intent.id), () =>
487:             this.fileMutations.dispatchRecordAndReconcile(String(intent.id))
488:           );
489:         } catch (error) {
490:           failed += 1;
491:           this.diagnosticObserver?.observe({
492:             eventKind: 'recovery.scan.failed',
493:             scopeKind: 'runtime',
494:             correlationId: String(intent.id),
495:             metadata: {
496:               kind: 'runtime-file-mutation-convergence',
497:               status: 'failed',
498:               hostBootId: this.database.hostBootId,
499:               errorName: safeErrorName(error)
500:             }
501:           });
502:         }
503:       }
504:       const dispatchedFileMutations = await listAllDomainRows(this.database, 'EffectIntent', {
505:         effect_kind: 'file_mutation',
506:         dispatch_state: 'dispatched'
507:       });
508:       for (const intent of dispatchedFileMutations) {
509:         const effectIntentId = String(intent.id);
510:         if (this.fileMutations.isDispatchActive(effectIntentId)) continue;
511:         const fence = await this.runtime.effects.readEffectDispatchFence(effectIntentId);
512:         if (fence?.hostBootId !== this.database.hostBootId) continue;
513:         try {
514:           await this.convergeOwnedEffect(effectIntentId, () =>
515:             this.fileMutations.recoverDispatchedAndReconcile(effectIntentId)
516:           );
517:         } catch (error) {
518:           failed += 1;
519:           this.diagnosticObserver?.observe({
520:             eventKind: 'recovery.scan.failed',
521:             scopeKind: 'runtime',
522:             correlationId: effectIntentId,
523:             metadata: {
524:               kind: 'runtime-dispatched-file-mutation-convergence',
525:               status: 'failed',
526:               hostBootId: this.database.hostBootId,
527:               errorName: safeErrorName(error)
528:             }
529:           });
530:         }
531:       }
532:       const convergence = await this.phaseDRecovery.reconcileCommittedFacts();
533:       failed += convergence.failed;
534:       await this.runtime.collaboration.reconcile();
535:     } catch (error) {
```

## backend/reliableKernel/conversationProject.ts:17

```text
17: /** Stable identity for one canonical workspace-folder URI. */
18: export function projectContextIdForUri(uriInput: string): string {
19:   const uri = requireText(uriInput, 'ProjectContext.uri');
20:   return `project_context_${digest(PROJECT_CONTEXT_ID_DOMAIN, uri)}`;
21: }
22: 
23: /** Stable one-primary-project relationship identity for a Conversation. */
24: export function conversationProjectLinkId(conversationIdInput: string): string {
25:   const conversationId = requireText(conversationIdInput, 'ConversationProjectLink.conversation_id');
26:   return `conversation_project_link_${digest(CONVERSATION_PROJECT_LINK_ID_DOMAIN, conversationId)}`;
27: }
28: 
29: /**
30:  * Prepare a canonical ProjectContext plus its independent Conversation relationship.
31:  *
32:  * The savepoint makes concurrent Extension Hosts converge on the same URI identity. The following
33:  * assert rejects a cryptographic-id collision or a conflicting canonical row instead of silently
34:  * binding the Conversation to unrelated project data.
35:  */
36: export function projectFolderAssignmentSteps(input: {
37:   conversationId: string;
38:   folder: ProjectFolderAssignment;
39:   now: string;
40: }): RepositoryTransactionStep[] {
41:   const conversationId = requireText(input.conversationId, 'conversationId');
42:   const uri = requireText(input.folder.uri, 'folder.uri');
43:   const name = requireText(input.folder.name, 'folder.name');
44:   const now = requireText(input.now, 'now');
45:   const projectContextId = projectContextIdForUri(uri);
```

## backend/reliableKernel/collaborationControlPlane.ts:516

```text
516:   public async authorizeCrossConversation(input: { turnId: string; targetConversationId?: string }): Promise<{ conversationId: string; projectContextId: string | null }> {
517:     const turn = await this.existing('Turn', requirePhaseFId(input.turnId, 'turnId'));
518:     const conversationId = String(turn.conversation_id);
519:     if (!await readTurnCrossConversationEnabled(this.database, this.contentStore, String(turn.id))) {
520:       throw new Error('Cross-conversation collaboration is not enabled for this Turn.');
521:     }
522:     if ((await this.rows('ChildExecution', { child_conversation_id: conversationId })).length) {
523:       throw new Error('Cross-conversation collaboration is only available to top-level conversations.');
524:     }
525:     const projectContextId = await this.projectOf(conversationId);
526:     if (input.targetConversationId === undefined) return { conversationId, projectContextId };
527:     const targetConversationId = requirePhaseFId(input.targetConversationId, 'targetConversationId');
528:     if (targetConversationId === conversationId) throw new Error('A cross-conversation action must target another Conversation.');
529:     const target = await this.existing('Conversation', targetConversationId);
530:     if (target.status !== 'active') throw new Error('Cross-conversation target is not an active Conversation.');
531:     if ((await this.rows('ChildExecution', { child_conversation_id: targetConversationId })).length) {
532:       throw new Error('Cross-conversation collaboration cannot address a child task conversation.');
533:     }
534:     if (await this.projectOf(targetConversationId) !== projectContextId) throw new Error(CROSS_PROJECT_REFUSAL);
535:     return { conversationId, projectContextId };
536:   }
```

## backend/reliableKernel/conversationDeletion.ts:24

```text
24: /**
25:  * Deletes one Conversation together with only its Subagent-origin descendants.
26:  *
27:  * ConversationOriginLink source fields are deliberately soft references, so SQLite cannot infer
28:  * this graph. The control plane freezes the exact descendant set, rejects any live work in that
29:  * set, and deletes descendants before the requested root in one writer transaction.
30:  */
```

## backend/reliableKernel/conversationDeletion.ts:89

```text
89:     }
90:     steps.push(...deletionOrder.map((targetId) =>
91:       DOMAIN_REPOSITORIES.domain('Conversation').delete(targetId)
92:     ));
93: 
94:     const ownershipOrder = [...deletionOrder].sort();
95:     const deleteOwned = async (index: number): Promise<ConversationDeleteResult> => {
96:       if (index < ownershipOrder.length) {
97:         return this.database.conversationOwners.run(ownershipOrder[index], () => deleteOwned(index + 1));
98:       }
99:       await this.database.transaction(steps);
100:       return { deletedConversationIds: deletionOrder };
101:     };
102:     return deleteOwned(0);
103:   }
104: 
105:   private async readSnapshot(rootConversationId: string): Promise<ConversationDeletionSnapshot | null> {
106:     const [conversations, childExecutions, origins, turns, leases, activeChildTurnLinks] =
107:       await Promise.all([
108:         listAllDomainRows(this.database, 'Conversation'),
109:         listAllDomainRows(this.database, 'ChildExecution'),
110:         listAllDomainRows(this.database, 'ConversationOriginLink'),
111:         listAllDomainRows(this.database, 'Turn'),
112:         listAllDomainRows(this.database, 'ExecutionLease'),
113:         listAllDomainRows(this.database, 'ChildExecutionActiveTurnLink')
114:       ]);
```

## backend/reliableKernel/modelProviderControlPlane.ts:1558

```text
1558:    * output from later delta samples. Semantic item boundaries and the terminal fence continue to
1559:    * await their own durable transaction.
1560:    */
1561:   private async recordDispatchStreamEvent(
1562:     modelRequestId: string,
1563:     attemptSeq: bigint,
1564:     socketGeneration: bigint,
1565:     event: ProviderOutputStreamEvent,
1566:     semanticProgress: boolean,
1567:     state: StreamDurabilityState
1568:   ): Promise<StreamEventResult> {
1569:     const observedAt = this.epochNow();
1570:     if (event.kind === 'output_delta' && state.outputDeltaCheckpointed) {
1571:       if (semanticProgress && await this.persistStreamActivityIfDue(
1572:         modelRequestId,
1573:         attemptSeq,
1574:         socketGeneration,
1575:         event.streamSeq,
1576:         observedAt,
1577:         state
1578:       )) {
1579:         return { accepted: false, checkpointed: false, terminal: true, ignoredReason: 'terminal' };
1580:       }
1581:       return this.recordUndurableDispatchEvent('coalesced');
1582:     }
1583: 
1584:     const result = await this.recordStreamEvent(modelRequestId, attemptSeq, socketGeneration, event);
1585:     if (
1586:       event.kind === 'output_delta'
```

## backend/reliableKernel/turnOutput.ts:180

```text
180:     /**
181:      * Whole-chain-so-far aggregate content for the durable current projection. The item-only
182:      * revision stays the Context source; the cumulative revision is the current pointer target so
183:      * a mid-stream reload never shows only one item. The final chain aggregate replaces it.
184:      */
185:     cumulativeContent: string | Uint8Array;
186:     contentType?: string;
187:     contextDisposition?: 'append' | 'exclude';
188:   }): Promise<AssistantMessageCommit> {
189:     const turnId = requireId(input.turnId, 'turnId');
190:     const modelRequestId = requireId(input.modelRequestId, 'modelRequestId');
191:     const itemKey = requireText(input.itemKey, 'itemKey');
192:     const contentType = requireText(input.contentType ?? 'application/vnd.limcode.message+json', 'contentType');
193:     const contextDisposition = input.contextDisposition ?? 'append';
194:     if (contextDisposition !== 'append' && contextDisposition !== 'exclude') {
195:       throw new TypeError(`Unsupported assistant output Context disposition: ${String(contextDisposition)}`);
196:     }
197:     const ids = outputIds(turnId, modelRequestId);
198:     const revisionId = nativeItemRevisionId(turnId, modelRequestId, itemKey);
199:     const cumulativeRevisionId = nativeCumulativeRevisionId(turnId, modelRequestId, itemKey);
200:     const identity = this.contentStore.identity(input.content, contentType);
201:     const cumulativeIdentity = this.contentStore.identity(input.cumulativeContent, contentType);
202:     const existingRevision = await this.maybeGet('MessageRevision', revisionId);
203:     if (existingRevision) {
204:       return this.replayNativeAssistantItem(
205:         ids,
206:         revisionId,
207:         cumulativeRevisionId,
208:         identity.id,
209:         cumulativeIdentity.id,
210:         itemKey
211:       );
212:     }
213:     const modelRequest = await this.requireExisting('ModelRequest', modelRequestId);
214:     if (modelRequest.turn_id !== turnId) throw new Error('ModelRequest belongs to another Turn.');
215:     const turn = await this.requireExisting('Turn', turnId);
216:     if (turn.status !== 'active') throw new Error(`Turn ${turnId} is not active.`);
217:     const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
218:     const leaseRows = await this.list('ExecutionLease', { turn_id: turnId }, 2);
219:     if (leaseRows.length !== 1) throw new Error(`Active Turn ${turnId} must have exactly one ExecutionLease.`);
220:     const content = await this.contentStore.prepare(this.database, input.content, contentType);
221:     const cumulativeContent = await this.contentStore.prepare(this.database, input.cumulativeContent, contentType);
222:     const existingMessage = await this.maybeGet('Message', ids.messageId);
223:     let contextSteps: RepositoryTransactionStep[] = [];
224:     if (contextDisposition === 'append') {
225:       const contentEstimatedTokens = estimateStoredMessageContentTokens(input.content, contentType);
226:       const context = await this.context.prepareMessageAppendMutation({
227:         conversationId,
228:         messageRevisionId: revisionId,
229:         contentObjectId: content.metadata.id,
230:         contentByteLength: content.metadata.byte_length,
```

## backend/reliableKernel/runtimeDataSetHistory.ts:44

```text
44: /**
45:  * Opens a command-scoped, read-only history snapshot, without RuntimeDatabase or a Host.
46:  * SQLite's readonly WAL connection can create source -wal/-shm files. Copy SQLite and its WAL
47:  * under admission/offline fencing, then open only that temporary copy. CAS stays on-demand.
48:  */
49: export async function openRuntimeDataSetHistory(
50:   paths: { globalStoragePath: string },
51:   candidateId: string
52: ): Promise<RuntimeDataSetHistory> {
53:   return withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
54:     const candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
55:     if (candidate.selected) throw new Error('Use the active conversation view for the selected Runtime data set.');
56:     const historical = await requireCompleteRuntimeDataSet(candidate);
57:     if (historical.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
58:       throw Object.assign(new Error('此历史库仍使用旧 Runtime 格式。请在“历史与存储管理”中选择该库并重载窗口，完成备份和离线升级后再读取；原数据保持不变。'), {
59:         code: 'runtime-history-offline-upgrade-required'
60:       });
61:     }
62:     const binding = historical as RootBinding;
63:     return withRuntimeMaintenance(binding.paths, async () => {
64:       await assertRuntimeHostsOffline(binding.paths);
65:       let snapshot: RuntimeDataSetDatabaseSnapshot | undefined;
66:       try {
67:         snapshot = await createRuntimeDataSetDatabaseSnapshot(candidate, binding);
68:         const { database } = snapshot;
69:         assertCurrentSchema(database, binding);
70:         assertRuntimePhysicalSchemaFingerprint(database, RUNTIME_DOMAIN_SCHEMAS, { label: 'Historical Runtime' });
71:         return new ReadonlyRuntimeDataSetHistory(paths, candidate, binding, database, snapshot);
72:       } catch (error) {
73:         await snapshot?.close();
74:         if (error instanceof Error) {
75:           error.message = `无法读取历史库：${error.message} 未执行任何迁移或重置。`;
76:         }
77:         throw error;
78:       }
79:     });
80:   });
```

## backend/reliableKernel/vscodeRootAuthority.ts:97

```text
97: export function resolveVscodeWorkspaceRuntimeScope(
98:   input: VscodeWorkspaceRuntimeScopeInput
99: ): VscodeWorkspaceRuntimeScope {
100:   const workspaceFileUri = normalizeUri(input.workspaceFileUri);
101:   const stableWorkspaceFileUri = /^untitled:/i.test(workspaceFileUri) ? '' : workspaceFileUri;
102:   const folderUris = [...new Set((input.workspaceFolderUris ?? []).map(normalizeUri).filter(isText))].sort();
103:   let kind: VscodeWorkspaceRuntimeScopeKind;
104:   let identity: string;
105:   if (stableWorkspaceFileUri) {
106:     kind = 'workspace-file';
107:     identity = stableWorkspaceFileUri;
108:   } else if (folderUris.length === 1) {
109:     kind = 'folder';
110:     identity = folderUris[0];
111:   } else if (folderUris.length > 1) {
112:     kind = 'folder-set';
113:     identity = JSON.stringify(folderUris);
114:   } else {
115:     kind = 'empty';
116:     identity = 'empty';
117:   }
118:   const digest = createHash('sha256')
119:     .update(WORKSPACE_RUNTIME_ID_DOMAIN)
```

## backend/reliableKernel/vscodeRootAuthority.ts:159

```text
159:  * A configuration root has one fixed Runtime selection. The workspace is retained as execution
160:  * context only. Existing roots stay in place, including their fenced RootBinding and CAS paths.
161:  * Callers hold the same admission through preparation and Host registration; this inner claim
162:  * also protects standalone callers. The normal selected-root path never enumerates old scopes.
163:  */
164: export async function resolveVscodeWorkspaceRuntimePlacement(
165:   paths: Pick<VscodeStoragePaths, 'globalStoragePath'>,
166:   scope: VscodeWorkspaceRuntimeScope
167: ): Promise<VscodeWorkspaceRuntimePlacement> {
168:   const configurationRootPath = path.resolve(paths.globalStoragePath);
169:   return withRuntimeDataRootAdmission(configurationRootPath, async () => {
170:     const selection = await readRuntimeDataSetSelection(configurationRootPath);
171:     let candidate: VscodeRuntimeDataSetCandidate;
172:     if (selection) {
173:       candidate = await inspectCandidate(configurationRootPath, selection.id, selection, !selection.initialized);
174:     } else {
175:       const candidates = await enumerateCandidates(configurationRootPath);
176:       if (candidates.length > 1) throw new VscodeRuntimeDataSetSelectionRequiredError(candidates);
177:       candidate = candidates[0] ?? await inspectCandidate(configurationRootPath, 'default', undefined, true);
178:       await assertConfigurationRootRuntimesOffline(configurationRootPath);
179:       await publishSelection(configurationRootPath, candidate.id, Boolean(candidate.dataSetId));
180:     }
181:     return Object.freeze({
182:       scope,
183:       configurationRootPath,
184:       runtimeScopeRootPath: candidate.runtimeScopeRootPath,
185:       runtimeDataRootPath: candidate.runtimeDataRootPath,
```

## backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.ts:156

```text
156:   public static async open(
157:     context: vscode.ExtensionContext
158:   ): Promise<VscodeReliableKernelApplicationFacade> {
159:     await loadCommittedGlobalStatus(context);
160:     const getPaths = (): StoragePaths => createVscodeStoragePaths(resolveDataRootUri(context));
161:     let facade: VscodeReliableKernelApplicationFacade | undefined;
162:     // The data-root admission serializes placement/cutover across every workspace scope sharing
163:     // this configuration root. It is acquired before placement resolution and the scope
164:     // maintenance claim nests inside it; both lock orders (open and reset) agree.
165:     return withRuntimeDataRootAdmission(path.resolve(getPaths().globalStoragePath), async () => {
166:       const runtimePlacement = await resolveVscodeWorkspaceRuntimePlacement(
167:         getPaths(),
168:         resolveVscodeWorkspaceRuntimeScope({
169:           workspaceFileUri: vscode.workspace.workspaceFile?.toString(),
170:           workspaceFolderUris: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString())
171:         })
172:       );
173:       const authority = createVscodeRootAuthority(runtimePlacement);
174:       // Root preparation and Runtime open share one short maintenance claim with the database
175:       // worker-ready + Host liveness registration, so a peer open or reset cannot interleave.
176:       const product = await withRuntimeMaintenance(authority.expectedPaths(), async () => {
177:         const rootPreparation = await new VscodeReliableKernelCutoverCoordinator(
178:           authority,
179:           runtimePlacement.runtimeScopeRootPath
180:         ).ensureCurrentRoot();
181:         if (rootPreparation.epochMigrationBackupPath) {
182:           console.info(
183:             `[LimCode] 已将第 ${rootPreparation.epochMigratedFrom} 代运行数据无损升级到第 ${RUNTIME_KERNEL_EPOCH} 代；`
184:             + `升级前 SQLite 备份：${rootPreparation.epochMigrationBackupPath}。`
185:           );
186:         }
187:         await completeVscodeRuntimeDataSetSelection(getPaths());
188:         return VscodeReliableKernelProductRuntime.open(context, {
189:           authority, runtimePlacement,
190:           onConfigurationChanged: async () => {
191:             await facade?.commandRouter.refreshConfiguration();
192:             await facade?.refreshConversationHistory();
193:           }
194:         });
195:       });
```

## backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.ts:596

```text
596:   private async refreshInteractionAttention(): Promise<void> {
597:     const requests = await this.list('InteractionRequest', { status: 'pending' }, 1000);
598:     const resolved = await Promise.all(requests.map((request) => this.resolveInteractionAttention(request)));
599:     if (this.disposed) return;
600:     this.interactionAttentionNotifier.synchronize(
601:       resolved.filter((request): request is PendingInteractionAttention => request !== undefined)
602:     );
603:   }
604: 
605:   private async resolveInteractionAttention(
606:     request: DomainRow
607:   ): Promise<PendingInteractionAttention | undefined> {
608:     const kind = interactionAttentionKind(request.request_kind);
609:     if (!kind) return undefined;
610:     const requestId = requireText(request.id, 'InteractionRequest.id');
611:     const owners = await this.list('InteractionOwnerLink', { request_id: requestId }, 2);
612:     if (owners.length !== 1) return undefined;
613:     const turnId = requireText(owners[0].turn_id, 'InteractionOwnerLink.turn_id');
614:     if (kind === 'plan_review') {
615:       const childMemberships = await this.list('ChildExecutionTurnLink', { turn_id: turnId }, 1);
616:       if (childMemberships.length > 0) return undefined;
617:     }
618:     const turn = await this.maybeRow('Turn', turnId);
619:     if (!turn) return undefined;
620:     const conversationId = requireText(turn.conversation_id, 'Turn.conversation_id');
621:     const conversation = await this.maybeRow('Conversation', conversationId);
622:     if (!conversation) return undefined;
623:     const conversationTitle = displayConversationTitle({
624:       id: conversationId,
625:       title: typeof conversation.title === 'string' ? conversation.title : ''
626:     });
627:     return {
628:       requestId,
629:       kind,
630:       conversationId,
631:       conversationTitle,
632:       createdAt: timestampMs(request.created_at)
633:     };
634:   }
635: 
```

## backend/application/reliableKernel/ReliableConversationRunner.ts:691

```text
691:   public async recoverStartup(
692:     signal?: AbortSignal,
693:     conversationId?: string
694:   ): Promise<ReliableConversationRunnerRecoveryReport> {
695:     this.requireOpen();
696:     signal?.throwIfAborted();
697:     const scopedConversationId = conversationId === undefined
698:       ? undefined
699:       : requireId(conversationId, 'Recovery Conversation.id');
700:     const childTurnIds = new Set(
701:       (await listAllDomainRows(this.application.database, 'ChildExecutionActiveTurnLink'))
702:         .map((link) => requireId(link.turn_id, 'ChildExecutionActiveTurnLink.turn_id'))
703:     );
704:     // The mutable active pointer is committed atomically with every child Turn admission. Reading
705:     // it avoids scanning immutable historical membership while still preventing this runner from
706:     // replacing the child coordinator's lease generation.
707:     const activeTurns = (await listAllDomainRows(this.application.database, 'Turn', {
708:       status: 'active',
709:       ...(scopedConversationId ? { conversation_id: scopedConversationId } : {})
710:     }))
```

## backend/application/reliableKernel/ReliableConversationRunner.ts:726

```text
726:       const turnId = requireId(turn.id, 'Turn.id');
727:       const turnConversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
728:       const facts = await this.application.turns.recoveryFacts(turnId);
729:       if (facts.judgment === 'needs_human') {
730:         report.needsHumanTurnIds.push(turnId);
731:         admissionBlockedConversationIds.add(turnConversationId);
732:         continue;
733:       }
734:       if (!await this.tryOwnConversation(turnConversationId, ownership)) {
735:         // A live peer Host owns this Conversation. Skipping it must not poison unrelated
736:         // recovery; the resume candidate stays level-triggered for a later release/shutdown.
737:         report.liveOwnedTurnIds.push(turnId);
738:         admissionBlockedConversationIds.add(turnConversationId);
739:         if (facts.judgment === 'resume') {
740:           this.deferredRecovery.set(turnId, { conversationId: turnConversationId, turnId });
741:           this.ensureExternalWakePolling();
742:         }
743:         continue;
```

## backend/application/reliableKernel/VscodeReliableToolHost.ts:302

```text
302:   public async resolveProcessCwd(
303:     input: ReliableAgentToolDispatchInput,
304:     authority: ReliableToolDispatchAuthority
305:   ): Promise<string> {
306:     const environments = await this.resolveEnvironments(authority);
307:     const active = environments.active;
308:     if (!active?.rootPath || active.kind !== 'localFolder') {
309:       throw new Error('可靠进程工具首发只允许具有本地 rootPath 的 active work environment。');
310:     }
311:     const args = asRecord(input.arguments);
312:     const requested = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '.';
313:     // A skill's bundled scripts may expect to run from the skill's own directory (by real path, so a
314:     // link inside a skill cannot lead the command out of it).
315:     if (path.isAbsolute(requested)) {
316:       const real = await realPathOfNearestExisting(requested);
317:       for (const dir of this.skillDirectoriesFor(authority)) {
318:         if (isInsideRoot(dir, requested) && isInsideRoot(await realPathOfNearestExisting(dir), real)) return path.resolve(requested);
319:       }
320:     }
321:     const root = path.resolve(active.rootPath);
322:     const cwd = path.resolve(root, requested);
323:     assertInsideRoot(root, cwd, 'command cwd');
324:     return cwd;
325:   }
326: 
327:   public dispatchSpecial(
```

## backend/application/reliableKernel/interactionAttention.ts:44

```text
44: /** Extension Host-local notification dedupe; reliable Interaction rows remain the decision authority. */
45: export class InteractionAttentionNotifier {
46:   private readonly activeRequestIds = new Set<string>();
47: 
48:   public constructor(private readonly host: InteractionAttentionHost) {}
49: 
50:   public synchronize(requests: readonly PendingInteractionAttention[]): void {
51:     const ordered = [...requests].sort((left, right) =>
52:       left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId)
53:     );
54:     const pendingRequestIds = new Set(ordered.map((request) => request.requestId));
55:     for (const requestId of this.activeRequestIds) {
56:       if (!pendingRequestIds.has(requestId)) this.activeRequestIds.delete(requestId);
57:     }
58: 
59:     const newGroupKeys = new Set<string>();
60:     for (const request of ordered) {
61:       if (!this.activeRequestIds.has(request.requestId)) {
62:         newGroupKeys.add(groupKey(request));
63:       }
64:       this.activeRequestIds.add(request.requestId);
65:     }
66: 
67:     for (const group of groupPendingAttention(ordered)) {
68:       if (!newGroupKeys.has(group.key)) continue;
69:       void Promise.resolve(this.host.showInformationMessage(
70:         interactionAttentionMessage(group),
71:         INTERACTION_ATTENTION_ACTION
72:       )).then((selection) => {
73:         if (selection !== INTERACTION_ATTENTION_ACTION) return undefined;
74:         return this.host.openConversation({
75:           conversationId: group.conversationId,
76:           ...(group.conversationTitle ? { conversationTitle: group.conversationTitle } : {})
77:         });
78:       }).catch((error) => this.host.onError?.(error));
```

## docs/architecture/reliable-kernel/agent-collaboration.md:131

```text
131: ### 项目范围（已定）
132: 
133: 跨对话工具只作用于与发起对话同一项目（`ConversationProjectLink`）的对话：列出、读取、发送和分支都限于当前项目，新建的对话建在当前项目。Runtime 由所有 VS Code 窗口共用，边界是项目而不是 Runtime。项目关联只在对话创建时写入、随对话删除，存续期间不会改变，因此检查不需要事务断言。
134: 
135: 每次读取、发送和分支都由协作控制面按目标对话的项目检查，不论引用从哪里得到（列表、同伴消息或分支复制的历史）：其他项目的对话一律拒绝，错误说明它属于另一个项目，不读取、不发送、不创建任何东西。
136: 
137: 未绑定项目的对话（空窗口或多根工作区里默认新建的对话）只与其他未绑定的对话互通，与侧栏的「未绑定」分组一致。一律拒绝会让这些窗口里的对话连自己新建的对话也无法续派或读取；而已绑定项目的对话无论哪个方向都与未绑定的对话隔离。
```

## backend/reliableKernel/contentAddressedStore.ts:399

```text
399: function contentObjectId(content: PublishedContent): string {
400:   const digest = createHash('sha256')
401:     .update('limcode-content-object\0')
402:     .update(content.contentType)
403:     .update('\0')
404:     .update(content.sha256)
405:     .update('\0')
406:     .update(content.byteLength.toString())
407:     .digest('hex');
408:   return `content_${digest}`;
409: }
410: 
```