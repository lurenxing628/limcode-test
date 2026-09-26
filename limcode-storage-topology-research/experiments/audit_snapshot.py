import sqlite3,pathlib,json,collections,os,time,zlib,hashlib
OUT=pathlib.Path('/tmp/limcode-topology-research-6pLhQV'); SRC=pathlib.Path.home()/'.vscode-server/data/User/globalStorage/your-publisher.limcode-test/.limcode-runtime/active'
c=sqlite3.connect((OUT/'snapshots/vscode.sqlite').as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
schema=json.loads((OUT/'evidence/vscode-schema.json').read_text());tables=[r[0] for r in c.execute('select table_name from schema_manifest')]
rows={t:[dict(r) for r in c.execute('select * from "'+t+'"')] for t in tables};byid={};parent={};edges=[];contentRefs=collections.defaultdict(set);unresolved=collections.Counter();ambiguous=collections.Counter()
for t,rs in rows.items():
 for r in rs:
  k=(t,r['id']);parent[k]=k;byid.setdefault(r['id'],[]).append(k)
def find(k):
 while parent[k]!=k: parent[k]=parent[parent[k]];k=parent[k]
 return k
def union(a,b):
 ra,rb=find(a),find(b)
 if ra!=rb:parent[rb]=ra
for t,rs in rows.items():
 fk={r[3]:(r[2],r[4]) for r in schema[t]['fks']};cols=[x[1] for x in schema[t]['columns'] if x[1]!='id' and (x[1].endswith('_id') or x[1] in ('source_id','owner_id','source_key','origin_key'))]
 for r in rs:
  a=(t,r['id'])
  for col in set(cols)|set(fk):
   value=r.get(col)
   if not isinstance(value,str):continue
   targets=[]
   if col in fk:
    tt,tc=fk[col]
    if tc!='id':raise RuntimeError('non-id FK needs manual audit')
    if (tt,value) in parent:targets=[(tt,value)]
    else:unresolved[t+'.'+col+' [FK]']+=1
   else:
    targets=byid.get(value,[])
    if len(targets)>1:ambiguous[t+'.'+col]+=1;continue
    if not targets:unresolved[t+'.'+col]+=1
   for b in targets:
    if b[0]=='content_object':contentRefs[b[1]].add(a)
    elif a[0]!='content_object':union(a,b);edges.append((a,b,t+'.'+col))
projectmap={r['conversation_id']:r['project_context_id'] for r in rows['conversation_project_link']};projectLabels={p:f'P{i+1}' for i,p in enumerate(sorted(set(projectmap.values())))}
scopes=collections.defaultdict(set)
for r in rows['conversation']:
 p=projectLabels.get(projectmap.get(r['id']),'unbound');scopes[find(('conversation',r['id']))].add(p)
for r in rows['project_context']:
 scopes[find(('project_context',r['id']))].add(projectLabels.get(r['id'],'unused-project'))
coverage={};cross=[]
for t,rs in rows.items():
 if t=='content_object':continue
 ct=collections.Counter()
 for r in rs:
  ss=scopes[find((t,r['id']))];ct[','.join(sorted(ss)) or 'unassigned']+=1
  if len(ss)>1:cross.append(t)
 coverage[t]=dict(ct)
objects=rows['content_object'];types=collections.defaultdict(lambda:{'objects':0,'logicalBytes':0,'allocatedBytes':0,'sqlUnreferencedObjects':0,'sqlUnreferencedBytes':0,'sharedProjectObjects':0})
missing=0;hashErrors=0;refprojects=collections.Counter();sharedbytes=0;sample=collections.defaultdict(list)
for r in objects:
 d=types[r['content_type']];d['objects']+=1;d['logicalBytes']+=r['byte_length'];p=SRC/'cas'/r['storage_key']
 try:d['allocatedBytes']+=p.stat().st_blocks*512
 except FileNotFoundError:missing+=1
 refs=contentRefs.get(r['id'],set());ps=set()
 for a in refs:ps.update(scopes[find(a)])
 if not refs:d['sqlUnreferencedObjects']+=1;d['sqlUnreferencedBytes']+=r['byte_length']
 if len(ps)>1:d['sharedProjectObjects']+=1;sharedbytes+=r['byte_length']
 refprojects[','.join(sorted(ps)) or 'unassigned']+=1
 sample[r['content_type']].append(r)
# Files added after the consistent DB backup are not classified as garbage.
fsCount=fsBytes=fsAllocated=0;uncatalogued=0;known={r['storage_key'] for r in objects}
for d,ds,fs in os.walk(SRC/'cas'):
 for f in fs:
  p=pathlib.Path(d)/f;s=p.stat();fsCount+=1;fsBytes+=s.st_size;fsAllocated+=s.st_blocks*512
  if str(p.relative_to(SRC/'cas')) not in known:uncatalogued+=1
compression=[]
for typ,rs in sorted(sample.items(),key=lambda x:sum(r['byte_length'] for r in x[1]),reverse=True)[:6]:
 selected=sorted(rs,key=lambda r:r['sha256'])[::max(1,len(rs)//150)][:150];raw=packed=0
 for r in selected:
  b=(SRC/'cas'/r['storage_key']).read_bytes();raw+=len(b);packed+=len(zlib.compress(b,6))
 compression.append({'type':typ,'sampleObjects':len(selected),'sampleBytes':raw,'zlib6Bytes':packed,'ratio':round(packed/raw,4)})
current={r[0] for r in c.execute('select distinct r.content_object_id from message_current_revision_link l join message_revision r on r.id=l.revision_id')};allRev={r['content_object_id'] for r in rows['message_revision']};obj={r['id']:r for r in objects}
pageStats=[dict(r) for r in c.execute('select name,sum(pgsize) bytes from dbstat group by name order by bytes desc limit 20')]
res={'snapshotAt':json.loads((OUT/'evidence/snapshot-baseline.json').read_text())['at'],'sqliteVersion':sqlite3.sqlite_version,'manifestDomains':len(tables),'nonemptyDomains':sum(bool(rows[t]) for t in tables),'conversationCounts':dict(collections.Counter(projectLabels.get(projectmap.get(r['id']),'unbound') for r in rows['conversation'])),'messages':len(rows['message']),'revisions':len(rows['message_revision']),'childExecutions':len(rows['child_execution']),'physicalFKEdges':sum(len(schema[t]['fks']) for t in tables),'resolvedGraphEdges':len(edges),'crossProjectNonContentTables':sorted(set(cross)),'unassignedNonContentRows':sum(v.get('unassigned',0) for v in coverage.values()),'ambiguousSoftReferenceColumns':dict(ambiguous),'unresolvedFields':dict(unresolved),'coverage':coverage,'contentTypes':dict(sorted(types.items(),key=lambda x:x[1]['logicalBytes'],reverse=True)),'missingCataloguedFiles':missing,'casFilesystem':{'files':fsCount,'logicalBytes':fsBytes,'allocatedBytes':fsAllocated,'notInSnapshotCatalog':uncatalogued,'note':'live CAS sampled after DB backup; not-in-catalog files include subsequent writes; not a GC candidate list'},'contentProjectCounts':dict(refprojects),'crossProjectSharedContentLogicalBytes':sharedbytes,'messageRevisionBytes':{'distinctAll':sum(obj[x]['byte_length'] for x in allRev),'distinctCurrent':sum(obj[x]['byte_length'] for x in current),'notCurrentButStillRetained':sum(obj[x]['byte_length'] for x in allRev-current)},'compressionSamples':compression,'databaseTopPageBytes':pageStats,'timeRange':dict(c.execute('select min(created_at),max(created_at) from conversation').fetchone()),'limitations':['soft references only include exact existing IDs in declared ID/key fields; unresolved fields listed for semantic review','empty tables do not establish future project closure','shared content is not treated as a domain ownership edge','CAS body-level references require codec review; SQL-unreferenced does not imply safely reclaimable']}
(OUT/'evidence/snapshot-audit.json').write_text(json.dumps(res,indent=2))
print(json.dumps({k:v for k,v in res.items() if k not in ('coverage','unresolvedFields','contentTypes','databaseTopPageBytes')},indent=2))
print('TOP TYPES',json.dumps(list(res['contentTypes'].items())[:6],indent=2))
