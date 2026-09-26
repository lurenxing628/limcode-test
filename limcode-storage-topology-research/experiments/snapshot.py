import sqlite3, pathlib, json, datetime, hashlib, os
out=pathlib.Path('/tmp/limcode-topology-research-6pLhQV')
roots={'vscode':pathlib.Path.home()/'.vscode-server/data/User/globalStorage/your-publisher.limcode-test','code-server':pathlib.Path.home()/'.local/share/code-server/User/globalStorage/your-publisher.limcode-test'}
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'pythonSQLite':sqlite3.sqlite_version,'datasets':{}}
for name,root in roots.items():
 source=root/'.limcode-runtime/active/limcode.sqlite'
 if not source.exists():continue
 target=out/'snapshots'/f'{name}.sqlite'
 src=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=5)
 dst=sqlite3.connect(str(target));src.backup(dst,pages=2048,sleep=.05);src.close()
 tables=[r[0] for r in dst.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
 schema={t:{'columns':[list(r) for r in dst.execute('pragma table_info("'+t+'")')],'fks':[list(r) for r in dst.execute('pragma foreign_key_list("'+t+'")')],'count':dst.execute('select count(*) from "'+t+'"').fetchone()[0]} for t in tables}
 check=dst.execute('pragma quick_check').fetchall();fks=dst.execute('pragma foreign_key_check').fetchall()
 (out/'evidence'/f'{name}-schema.json').write_text(json.dumps(schema,indent=2))
 ddl=';\n'.join(r[0] for r in dst.execute("select sql from sqlite_master where sql is not null order by type,name"))+';\n'
 (out/'evidence'/f'{name}-schema.sql').write_text(ddl)
 dst.close()
 result['datasets'][name]={'source':str(source),'snapshotBytes':target.stat().st_size,'quickCheck':check,'foreignKeyViolations':len(fks),'tables':len(tables),'sourceFileBytes':{s:os.stat(str(source)+s).st_size for s in ('','-wal','-shm') if os.path.exists(str(source)+s)},'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}
(out/'evidence'/'snapshot-baseline.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
