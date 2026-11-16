// AGY command hook. Never forward transcript paths, prompts, tool data or secrets.
// Failure permits native stop; the Happy controller then reports unconfirmed work.
'use strict';
const net = require('node:net');
let done = false;
let socket;
const rawTimeoutMs = Number(process.argv[3]);
const timeoutMs = Number.isSafeInteger(rawTimeoutMs) && rawTimeoutMs >= 1000 && rawTimeoutMs <= 120000 ? rawTimeoutMs : 20000;
const timer = setTimeout(() => finish({}), timeoutMs);
function finish(value) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  socket?.destroy();
  process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(0));
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => finish({}));
process.stdin.on('data', chunk => {
  input += chunk;
  // Native input includes lastUserInput even though it is never forwarded.
  if (Buffer.byteLength(input) > 16 * 1024 * 1024) finish({});
});
process.stdin.on('end', () => {
  if (done) return;
  let filtered = {};
  try {
    const d = JSON.parse(input);
    for (const key of ['conversationId', 'hookEventName', 'executionNum', 'terminationReason', 'fullyIdle', 'continuationActive']) {
      if (typeof d?.[key] === 'boolean' || typeof d?.[key] === 'number' || (typeof d?.[key] === 'string' && d[key].length <= 128)) filtered[key] = d[key];
    }
  } catch { /* Report invalid input to the active controller without raw data. */ }
  try { socket = net.createConnection(process.argv[2]); } catch { finish({}); return; }
  socket.setEncoding('utf8');
  socket.on('error', () => finish({}));
  socket.on('connect', () => socket.write(JSON.stringify(filtered) + '\n'));
  let response = '';
  socket.on('data', chunk => {
    response += chunk;
    if (Buffer.byteLength(response) > 4096) { finish({}); return; }
    if (!response.includes('\n')) return;
    try {
      const d = JSON.parse(response.slice(0, response.indexOf('\n')));
      finish(d.decision === 'continue' && typeof d.reason === 'string' ? { decision: 'continue', reason: d.reason } : {});
    } catch { finish({}); }
  });
  socket.on('end', () => finish({}));
});
