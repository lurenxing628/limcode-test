import ts from 'typescript';
import { writeCompileBuildId } from './lib/compile-build-id.mjs';

const formatHost = {
  getCanonicalFileName: file => file,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine
};
const reportDiagnostic = diagnostic => ts.sys.write(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost));
const reportStatus = (diagnostic, newLine, _options, errorCount) => {
  ts.sys.write(`${ts.flattenDiagnosticMessageText(diagnostic.messageText, newLine)}${newLine}`);
  if (errorCount === 0) writeCompileBuildId();
};
// A failed watch round keeps the last successful output and its identity together.
const host = ts.createWatchCompilerHost('tsconfig.json', { noEmitOnError: true }, ts.sys,
  ts.createEmitAndSemanticDiagnosticsBuilderProgram, reportDiagnostic, reportStatus);
ts.createWatchProgram(host);
