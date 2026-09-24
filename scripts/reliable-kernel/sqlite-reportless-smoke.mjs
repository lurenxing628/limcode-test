import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const original = process.report.getReport;
try {
  process.report.getReport = () => undefined;
  const Database = require('better-sqlite3');
  const database = new Database(':memory:');
  try {
    const row = database.prepare('SELECT 42 AS answer').get();
    if (row?.answer !== 42) throw new Error('Reportless SQLite smoke returned an unexpected result.');
  } finally {
    database.close();
  }
} finally {
  process.report.getReport = original;
}
console.log('better-sqlite3 opens without a process report.');
