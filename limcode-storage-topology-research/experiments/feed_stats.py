import json,pathlib,collections,statistics
out=pathlib.Path('/tmp/limcode-topology-research-6pLhQV');root=pathlib.Path.home()/'.vscode-server/data/User/globalStorage/your-publisher.limcode-test/.limcode-runtime/active/diagnostics';posted={};acks={};first=None;last=None
for f in root.glob('events*.jsonl'):
 for line in f.open():
  try:r=json.loads(line)
  except:continue
  t=r.get('observedAt','');first=min(first,t) if first else t;last=max(last,t) if last else t
  k=r.get('eventKind');m=r.get('metadata',{});key=(m.get('sessionId'),m.get('messageSeq'))
  if k=='feed.data.posted':posted[key]=m
  if k=='feed.data.acked':acks[key]=m.get('elapsedMs')
def stats(a):
 a=sorted(a)
 return {'n':len(a),'p50':statistics.median(a),'p95':a[min(len(a)-1,int(len(a)*.95))],'p99':a[min(len(a)-1,int(len(a)*.99))],'min':a[0],'max':a[-1]} if a else {'n':0}
types=collections.defaultdict(list)
for key,m in posted.items():types[m.get('kind')].append((m.get('bytes',0),acks.get(key)))
r={'window':[first,last],'groups':{k:{'bytes':stats([b for b,a in v]),'ackMs':stats([a for b,a in v if isinstance(a,(int,float))])} for k,v in types.items()},'note':'rotating logs; matched posted/acked events; not a controlled multi-window benchmark'}
(out/'evidence/feed-diagnostics.json').write_text(json.dumps(r,indent=2));print(json.dumps(r,indent=2))
