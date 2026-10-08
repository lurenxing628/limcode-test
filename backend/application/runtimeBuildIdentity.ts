import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/** 随模块装载固定本次编译身份；重新编译后的磁盘记录不能替旧进程声称新身份。 */
export const LOADED_RUNTIME_BUILD = readLoadedBuild();

function readLoadedBuild(): { buildId?: string; sourceCommit: string } {
  try {
    const record = JSON.parse(readFileSync(path.join(__dirname, '../../compile-build-id.json'), 'utf8'));
    return {
      ...(typeof record.buildId === 'string' && record.buildId ? { buildId: record.buildId } : {}),
      sourceCommit: typeof record.commitSha === 'string' && /^[a-f0-9]{40}$/.test(record.commitSha)
        ? `${record.commitSha}${record.worktreeClean === false ? ':含未提交改动' : ''}` : '未找到构建来源'
    };
  } catch {
    return { sourceCommit: '未找到构建来源' };
  }
}
