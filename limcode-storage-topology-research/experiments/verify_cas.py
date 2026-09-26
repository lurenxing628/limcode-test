import sqlite3,pathlib,json,hashlib,collections,time
out=pathlib.Path('/tmp/limcode-topology-research-6pLhQV');src=pathlib.Path.home()/'.vscode-server/data/User/globalStorage/your-publisher.limcode-test/.limcode-runtime/active/cas';c=sqlite3.connect((out/'snapshots/vscode.sqlite').as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
objects=[dict(r) for r in c.execute('select * from content_object')];tables=[r[0] for r in c.execute('select table_name from schema_manifest')];ids=set();refs=set();semanticCounter=collections.Counter();semanticContentRefs=set();keys={};missing=hashMismatch=lengthMismatch=0
for t in tables:
 ids.update(r[0] for r in c.execute(f'select id from "{t}"'))
 for fk in c.execute(f'pragma foreign_key_list("{t}")'):
  if fk['table']=='content_object':refs.update(r[0] for r in c.execute(f'select distinct "{fk["from"]}" from "{t}" where "{fk["from"]}" is not null'))
for r in objects:keys.setdefault(r['storage_key'],[]).append(r)
semanticFields={'conversationId','sourceConversationId','targetConversationId','turnId','sourceTurnId','toolCallId','modelRequestId','messageId','messageRevisionId','contextRootId','sourceRootId','contentObjectId','rootId','attachmentId','childExecutionId','pendingTurnInputId'}
def scan(v):
 if isinstance(v,list):
  for x in v:scan(x)
 elif isinstance(v,dict):
  for k,x in v.items():
   if isinstance(x,str) and x in ids and (k in semanticFields or k.endswith('_id')):
    semanticCounter[k]+=1
    if k=='contentObjectId' or k.endswith('_object_id'):semanticContentRefs.add(x)
   if isinstance(x,(dict,list)):scan(x)
logical=allocated=0;start=time.monotonic()
for key,rs in keys.items():
 p=src/key
 try:b=p.read_bytes();st=p.stat()
 except FileNotFoundError:missing+=1;continue
 logical+=len(b);allocated+=st.st_blocks*512
 if hashlib.sha256(b).hexdigest()!=rs[0]['sha256']:hashMismatch+=1
 if any(r['byte_length']!=len(b) for r in rs):lengthMismatch+=1
 if any('json' in r['content_type'] for r in rs):
  try:scan(json.loads(b))
  except (ValueError,UnicodeError):pass
allRefs=refs|semanticContentRefs
unref=[rs[0] for rs in keys.values() if not any(r['id'] in allRefs for r in rs)]
r={'uniqueCataloguedFiles':len(keys),'catalogueObjects':len(objects),'logicalBytes':logical,'allocatedBytes':allocated,'missing':missing,'digestMismatch':hashMismatch,'lengthMismatch':lengthMismatch,'semanticIdFieldOccurrences':dict(semanticCounter),'bodyOnlyContentRefs':len(semanticContentRefs-refs),'candidateUnreferencedPhysicalFiles':len(unref),'candidateUnreferencedPhysicalBytes':sum(x['byte_length'] for x in unref),'seconds':time.monotonic()-start,'warning':'candidate only, not deletion approval; body scan is heuristic and active operations/backups/frozen records require retention roots; all reads against source CAS are non-mutating'}
(out/'evidence/cas-integrity.json').write_text(json.dumps(r,indent=2));print(json.dumps(r,indent=2))
