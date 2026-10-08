// Copied targets no longer enter a relocation, so no crash hook may rename or mutate them.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {createFixture,planWithRuntime,relocation,treeSnapshot} from './runtime-data-root-relocation-fixture.mjs';

test('拷来目录在任何迁移写入之前拒绝，源和目标逐文件不变',async t=>{
 const fixture=await createFixture(t);
 const target=path.join(fixture.base,'copied-target');
 await fs.cp(fixture.root,target,{recursive:true});
 const before=await treeSnapshot(target);
 const source=await treeSnapshot(fixture.root);
 const plan=await planWithRuntime(fixture,target);
 assert.equal(plan.target.kind,'occupied');
 assert.ok(plan.problems.length);
 let mutations=0;
 await assert.rejects(relocation.stageDataRootRelocation(plan,{beforeTargetChange(){mutations++;}}),{code:'data-root-relocation-precondition'});
 assert.equal(mutations,0);
 assert.deepEqual(await treeSnapshot(target),before);
 assert.deepEqual(await treeSnapshot(fixture.root),source);
 assert.equal((await fs.readdir(fixture.base)).some(name=>name.includes('.limcode-copied-')),false);
});
