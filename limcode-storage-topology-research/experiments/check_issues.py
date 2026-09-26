import subprocess,json,pathlib,concurrent.futures
out=pathlib.Path('/tmp/limcode-topology-research-6pLhQV/evidence')
items=[('openai/codex',21847),('openai/codex',42589),('openai/codex',34986),('anomalyco/opencode',10597),('anomalyco/opencode',47567),('anomalyco/opencode',46833),('anomalyco/opencode',37495),('anomalyco/opencode',49225),('anthropics/claude-code',1516),('anthropics/claude-code',62476),('earendil-works/pi',9001),('earendil-works/pi',8300),('microsoft/vscode',334228),('microsoft/vscode',320671)]
def run(x):
 repo,num=x;p=subprocess.run(['gh','api',f'repos/{repo}/issues/{num}'],capture_output=True,text=True,timeout=30)
 if p.returncode:return {'repo':repo,'number':num,'error':p.stderr[:350]}
 d=json.loads(p.stdout);r={k:d.get(k) for k in ('number','title','state','state_reason','html_url','created_at','updated_at','closed_at','body')};r['repo']=repo;r['pull_request']=bool(d.get('pull_request'))
 if r['pull_request']:
  p=subprocess.run(['gh','api',f'repos/{repo}/pulls/{num}'],capture_output=True,text=True,timeout=30)
  if not p.returncode:
   pr=json.loads(p.stdout);r['merged_at']=pr.get('merged_at');r['merge_commit_sha']=pr.get('merge_commit_sha')
 return r
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:res=list(pool.map(run,items))
(out/'upstream-issues.json').write_text(json.dumps(res,ensure_ascii=False,indent=2))
for r in res:print(r['repo'],r['number'],r.get('state'),r.get('merged_at'),r.get('title',r.get('error')))
