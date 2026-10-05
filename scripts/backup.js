'use strict';
/** npm run backup -> snapshot of the database + full-log CSV in BACKUP_DIR (default ./backups). */
const { backupNow } = require('../lib/exporter');

try {
  const r = backupNow();
  console.log(`Backup written:\n  ${r.dbFile}\n  ${r.csvFile}`);
} catch (e) {
  console.error(`Backup failed: ${e.message}`);
  process.exitCode = 1;
}
