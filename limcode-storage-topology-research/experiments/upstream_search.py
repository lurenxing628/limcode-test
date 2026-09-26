import subprocess,pathlib,json
out=pathlib.Path('/tmp/limcode-topology-research-6pLhQV');repos=json.loads((out/'evidence/upstream-baseline.json').read_text())
queries={
'codex/repo-156':['reduce lock contention|thread-writer-locks','busy_timeout|ignore_missing','thread_history_|state_5|STATE_DB_FILENAME'],
'codex/repo-main':['app-server-daemon|thread-writer-locks|reduce lock contention'],
'opencode/repo':['busy_timeout|journal_mode|BEGIN IMMEDIATE','opencode.db|projectID'],
'opencode/v2':['service.json|standalone','busy_timeout|journal_mode|BEGIN IMMEDIATE','session_v2|session_message','INSERT OR IGNORE|insertOrIgnore'],
'pi/upstream':['getDefaultSessionDir|\.jsonl|O_APPEND','sqlite.*experimental|sqlite.*session|sqlite-session'],
'pi/omp':['busyTimeout|SQLITE_BUSY|O_APPEND','class.*Session|history.db|agent.db|session_titles'],
'vscode-ext/vscode':['class ChatSessionStore|chatSessions','agent-host.db|session-store.db','journal_mode.*DELETE|busy_timeout.*10000'],
'vscode-ext/cline':['sessions.db|workspace_root|Workspace Only'],
'vscode-ext/Roo-Code':['history_item.json|proper-lockfile'],
'vscode-ext/continue':['workspaceDirectory|sessions.json']}
for name,patterns in queries.items():
 for i,pattern in enumerate(patterns):
  p=subprocess.run(['git','-C',repos[name]['path'],'grep','-n','-E',pattern,'--',':!*.lock',':!package-lock.json',':!*.svg'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  lines=p.stdout.splitlines();file=name.replace('/','-')+f'-search-{i}.txt';(out/'evidence'/file).write_text(p.stdout)
  print(name,pattern,'HITS',len(lines))
  for l in lines[:5]: print(l[:230])
