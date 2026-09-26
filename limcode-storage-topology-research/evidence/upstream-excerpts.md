### pi/upstream/packages/coding-agent/src/core/session-manager.ts

587:  * Encodes cwd into a safe directory name under ~/.pi/agent/sessions/.
588:  */
589: function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
590: 	const resolvedCwd = resolvePath(cwd);
591: 	const resolvedAgentDir = resolvePath(agentDir);
592: 	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
593: 	return join(resolvedAgentDir, "sessions", safePath);
594: }
595: 
596: export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
597: 	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
598: 	if (!existsSync(sessionDir)) {
599: 		mkdirSync(sessionDir, { recursive: true });
600: 	}
601: 	return sessionDir;

### pi/upstream/packages/agent/docs/harness.md

365: **Snapshot compaction (J1 — specified, not implemented).** In SQLite a value `set` is an in-place upsert; in JSONL every `set` appends, so a 30-turn run leaves ~10 dead `pi.op.state` lines after the terminal `delete`: the file grows with write history even though logical state does not. The specified fix rewrites the file as `header + current entries + current values + surviving list elements + usage rows` via temp file + atomic rename. Surviving lines keep their original `seq` values (dropped-line gaps are legal; no renumbering). Each surviving list element is rewritten as an append record carrying its original `seq`, merged in sequence order — never collapsed into one synthetic append — so list cursors survive. Deleted lists produce no snapshot records; the `nextSeq` high-water mark is preserved so dropping a trailing delete line cannot permit sequence reuse. Compact on open when the dead-bytes ratio crosses a threshold, after a terminal or outcome-staging deletion pushes the file across it, and always after a schema migration (Part 7); between compactions, operation is append-only and O(1) per commit.
366: 
367: Until J1 lands, deleted pending payloads, superseded state revisions, superseded tool checkpoints, and deleted frame lists linger as bytes indefinitely — logical deletion is immediate; physical deletion currently never happens. Tool authors therefore own bounded checkpoint values, cadence, and duplicate suppression (bash: live updates at 100 ms, checkpoints at most every two seconds, only when changed; at 50 KiB per checkpoint, continuously changing output adds ~15 MiB per ten minutes). Assistant frame lists grow linearly with model output; the [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md) replaces per-frame durable and replication writes with tracked output in scoped storage. One small immutable `pi.result` record per terminal operation is retained forever and copied into every later snapshot — result growth is linear in operation count by design. Deployments needing prompt physical removal of sensitive cancelled content compact eagerly at terminal boundaries, once J1 exists.
368: 
369: ### SQLite
370: 
371: Backend: `packages/session-backends/sqlite-node`. **One database file per session is the default; a shared container is supported.** Without `databasePath`, safe alphanumeric/underscore/hyphen ids retain `{id}.sqlite`; every other explicit id uses a `~`-prefixed base64url encoding of its UTF-16 code units, so separators, dots, percent signs, and Unicode cannot escape `directory`. With `databasePath`, any number of Sessions share one container. Metadata reports the canonical physical container path. Every authoritative and projection row is scoped by `session_id`; shared containers are a supported deployment mode, not an implementation detail to remove. SQLite supplies atomic transactions and coherent WAL snapshots, not Session ownership.
372: 
373: `001_initial.sql` (storage version 1), all scoped by `session_id`:
374: 
375: ```sql
376: entries(id, parent_id, seq, type, custom_type, timestamp, payload) WITHOUT ROWID;
377:   -- ix_entry_parent(parent_id), ix_entry_seq(seq, type)
378: scalar_values(namespace, key, seq, value, PRIMARY KEY (namespace, key)) WITHOUT ROWID;
379: list_values(namespace, key, seq, value, PRIMARY KEY (namespace, key, seq)) WITHOUT ROWID;
380: usage_ledger(id, seq, entry_id, adjustment, usage, details) WITHOUT ROWID;

### vscode-ext/vscode/extensions/copilot/src/platform/chronicle/node/sessionStore.ts

107: 			throw err;
108: 		}
109: 	}
110: 
111: 	/**
112: 	 * Open the database, configure pragmas and ensure the schema exists.
113: 	 */
114: 	private openDb(): DatabaseSync {
115: 		if (this.dbPath !== ':memory:') {
116: 			mkdirSync(dirname(this.dbPath), { recursive: true });
117: 		}
118: 
119: 		const db = new DatabaseSync(this.dbPath);
120: 		try {
121: 			if (this.remote) {
122: 				// WAL requires shared-memory (-shm) plus POSIX byte-range locking,
123: 				// neither of which network filesystems reliably provide. A rollback
124: 				// journal with a longer busy timeout is far more robust there.
125: 				db.exec('PRAGMA journal_mode = DELETE');
126: 				db.exec('PRAGMA busy_timeout = 10000');
127: 				db.exec('PRAGMA synchronous = NORMAL');
128: 			} else {
129: 				db.exec('PRAGMA journal_mode = WAL');
130: 				db.exec('PRAGMA busy_timeout = 3000');
131: 			}
132: 			db.exec('PRAGMA foreign_keys = ON');
133: 			this.db = db;
134: 			this.ensureSchema();
135: 		} catch (err) {
136: 			db.close();

### opencode/v2/packages/core/src/database/database.ts

28: // releasing a shared semaphore resumes the waiting object's fiber inside the
29: // releasing object's I/O context, where its first storage call is rejected as
30: // cross-object I/O.
31: const databaseLayer = (lock: Effect.Effect<Semaphore.Semaphore>) =>
32:   Layer.effect(
33:     Service,
34:     Effect.gen(function* () {
35:       const db = yield* makeDatabase
36: 
37:       if (supportsTuningPragmas) {
38:         yield* db.run("PRAGMA journal_mode = WAL")
39:         yield* db.run("PRAGMA synchronous = NORMAL")
40:         yield* db.run("PRAGMA busy_timeout = 5000")
41:         yield* db.run("PRAGMA cache_size = -64000")
42:         yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
43:       }
44:       // Durable Object SQLite always enforces foreign keys and rejects the pragma.
45:       if (supportsForeignKeyToggle) yield* db.run("PRAGMA foreign_keys = ON")
46:       const semaphore = yield* lock
47:       yield* semaphore.withPermit(DatabaseMigration.apply(db))
48: 
49:       return { db }
50:     }).pipe(Effect.orDie),
51:   )
52: 
53: // Two instances over one file bootstrap the same schema, so file databases
54: // share a lock per path. Each in-memory database is its own connection.
55: const locks = new Map<string, Semaphore.Semaphore>()

### opencode/v2/packages/cli/src/services/service-config.ts

75:   if (Option.isNone(text)) return
76:   if (Option.isNone(yield* decodeInfo(text.value).pipe(Effect.option))) return
77:   yield* fs.writeFileString(file, text.value, { flag: "wx", mode: 0o600 }).pipe(Effect.ignore)
78: })
79: 
80: function configKey(key: string): Key {
81:   if (key === "hostname" || key === "port" || key === "password" || key === "cors" || key === "env") return key
82:   throw new Error(`Unknown service config key: ${key}`)
83: }
84: 
85: const paths = Effect.gen(function* () {
86:   const fs = yield* FileSystem.FileSystem
87:   const global = yield* Global.Service
88:   const name = filename()
89:   const legacy = legacyFilename()
90:   const file = path.join(global.state, name)
91:   return {
92:     fs,
93:     file,
94:     legacyConfigFile: legacy ? path.join(global.config, legacy) : undefined,
95:     legacyRegistrationFiles: [
96:       ...(legacy ? [path.join(global.state, legacy)] : []),
97:       ...(name !== "service.json" && OPENCODE_CHANNEL !== "local" ? [path.join(global.state, "service.json")] : []),
98:     ],
99:     configFile: path.join(global.config, name),
100:   }
101: })
102: 
103: export const options = Effect.fnUntraced(function* (input: { readonly checkVersion?: boolean } = {}) {
104:   const { file, legacyRegistrationFiles } = yield* paths
105:   yield* Effect.forEach(legacyRegistrationFiles, (legacy) => migrateRegistration(legacy, file))
106:   return {

### pi/omp/packages/coding-agent/src/session/session-storage.ts

359:  * editors), against which the size check still fails closed whenever the
360:  * skew is detectable.
361:  *
362:  * The region is held for microseconds and never yields, so in-process
363:  * contention is impossible; cross-process contention fails closed after a
364:  * short bounded wait instead of blocking the turn loop.
365:  */
366: const SESSION_PUBLISH_LOCK_WAIT_MS = 500;
367: const SESSION_PUBLISH_LOCK_POLL_MS = 2;
368: 
369: const publishLockSleepBuffer = new Int32Array(new SharedArrayBuffer(4));
370: 