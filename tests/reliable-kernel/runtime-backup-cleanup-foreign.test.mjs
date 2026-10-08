// Completed-source cleanup uses successful merge facts, not cross-library coverage scans.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {createConfigurationRoot,removeConfigurationRoot,seedConversations,kernel,kernelFile,registerPendingHistory} from './fixtures/runtime-merge-fixture.mjs';
import {archiveLegacyRuntimeRoot} from './runtime-data-root-relocation-fixture.mjs';
const foreign=kernelFile('runtimeForeignHistory.js');
const registry=kernelFile('runtimeHistoryRegistry.js');
const {mergeHistoricalDataSetsOnline}=kernelFile('runtimeDataSetMerge.js');
const {planRuntimeBackupCleanup,deleteRuntimeBackups}=kernelFile('runtimeBackupCleanup.js');
const {registerForeignRuntimeHistoryView}=kernelFile('runtimeForeignHistoryViews.js');

async function fixture(t,merged=true){
 const f=await createConfigurationRoot();t.after(()=>removeConfigurationRoot(f.root));
 await seedConversations(f.alpha,[{id:'retained_history'}]);
 const {backupPath}=await archiveLegacyRuntimeRoot(f.alpha.authority,f.alpha.scopeRoot);
 await kernel.initializeEmptyRuntimeRoot(f.alpha.authority);
 const source=(await foreign.discoverForeignRuntimeHistory({configurationRootPath:f.root})).find(s=>s.location.containerPath===backupPath);
 assert.ok(source);
 const root=await foreign.locateForeignRuntimeRoot(f.root,source.location);
 const database=await kernel.RuntimeDatabase.open(f.current.authority,{hostBootId:'cleanup-current'});t.after(()=>database.close());
 if(merged){
   await registerPendingHistory(f.paths,{id:source.id,location:source.location,expectedDataSetId:root.recorded.dataSetId,expectedRootInstanceId:root.recorded.rootInstanceId});
   const result=await mergeHistoricalDataSetsOnline(f.paths,{configurationRootPath:f.root,database},{candidateIds:[source.id],requested:true});
   assert.equal(result.merged.length,1,JSON.stringify(result));
 }
 return {...f,source,foreignRoot:root,backupPath,database};
}
async function item(f){const plan=await planRuntimeBackupCleanup(f.root,f.database);return {plan,item:plan.items.find(i=>i.path===f.backupPath)};}

test('外来来源只有完整合并成功且缓存未变才可删除',async t=>{
 for(const merged of [false,true]){const f=await fixture(t,merged),v=await item(f);assert.equal(v.item.deletable,merged,v.item.reason);if(merged){const r=await deleteRuntimeBackups(v.plan,f.database,[v.item.key]);assert.equal(r.deleted.length,1,JSON.stringify(r));await assert.rejects(fs.stat(f.backupPath),{code:'ENOENT'});}}
});

test('外来来源的只读查看登记与声明占用均阻止删除',async t=>{
 const f=await fixture(t),v=await item(f);assert.equal(v.item.deletable,true,v.item.reason);
 const view=await registerForeignRuntimeHistoryView(f.root,f.source.id);
 try{assert.equal((await deleteRuntimeBackups(v.plan,f.database,[v.item.key])).deleted.length,0);}finally{await view.release();}
 let release,enter;const ready=new Promise(r=>enter=r),pause=new Promise(r=>release=r);
 const hold=foreign.tryWithForeignRuntimeRootClaim(f.root,f.source.id,f.foreignRoot.located.rootPointerPath,async()=>{enter();await pause;});await ready;
 try{assert.equal((await deleteRuntimeBackups(v.plan,f.database,[v.item.key])).deleted.length,0);}finally{release();await hold;}
 assert.equal((await deleteRuntimeBackups(v.plan,f.database,[v.item.key])).deleted.length,1);
});

test('外来来源的残留、待合并、嵌套备份、符号链接和缓存失效都保留',async t=>{
 for(const mode of ['residual','pending','backup','link','cache']){
  const f=await fixture(t),base={id:f.source.id,sourceKind:'archive',location:f.source.location};
  if(mode==='residual')await registry.writeRuntimeHistoryResidual(f.paths,{...base,code:'keep',message:'keep',checkedAt:new Date().toISOString()});
  if(mode==='pending')await registry.writeRuntimeHistoryPending(f.paths,{...base,reason:'retry',registeredAt:new Date().toISOString()});
  if(mode==='backup')await fs.mkdir(path.join(f.backupPath,'merge-backups'));
  if(mode==='link')await fs.symlink(f.current.binding.paths.databasePath,path.join(f.foreignRoot.located.casRootPath,'keep-link'));
  if(mode==='cache')await fs.rm(path.join(f.root,'.limcode-runtime-merges','fingerprints'),{recursive:true,force:true});
  assert.equal((await item(f)).item.deletable,false,mode);assert.ok(await fs.stat(f.backupPath));
 }
});

test('外来来源改名后未核对失败恢复，已核对后中断在同一声明下收尾',async t=>{
 for(const stop of ['after-rename','after-verify']){
  const f=await fixture(t),v=await item(f);assert.equal(v.item.deletable,true,v.item.reason);
  const r=await deleteRuntimeBackups(v.plan,f.database,[v.item.key],{onFaultPoint(point){if(point===stop)throw Error('injected');}});
  assert.equal(r.deleted.length,0);
  const again=await planRuntimeBackupCleanup(f.root,f.database);
  if(stop==='after-rename')assert.ok(await fs.stat(f.backupPath));
  else{assert.equal(again.finishedDeletions.length,1);await assert.rejects(fs.stat(f.backupPath),{code:'ENOENT'});}
 }
});

test('外来来源列出后被改动，目录状态复核阻止删除',async t=>{
 const f=await fixture(t),v=await item(f);assert.equal(v.item.deletable,true,v.item.reason);
 await fs.writeFile(path.join(f.backupPath,'keep.txt'),'new content');
 const r=await deleteRuntimeBackups(v.plan,f.database,[v.item.key]);assert.equal(r.deleted.length,0);assert.equal(await fs.readFile(path.join(f.backupPath,'keep.txt'),'utf8'),'new content');
});
