'use strict';
/**
 * npm run dev: the Express server (restarts when its code changes) plus Vite's dev server (live reload for the
 * Svelte app). Open the address Vite prints; it passes /api and /logout through to Express.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const procs = [
  // --watch restarts Express when server.js or anything it loads (lib/) changes.
  spawn(process.execPath, ['--env-file-if-exists=.env', '--disable-warning=ExperimentalWarning', '--watch',
    'server.js'], { stdio: 'inherit' }),
  spawn(process.execPath, [path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js')], { stdio: 'inherit' }),
];

const stop = () => { for (const p of procs) p.kill(); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) stop(); });
