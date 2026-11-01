import './offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Socket } from 'node:net';

test('offline HTTP guard rejects remote requests before connecting', async () => {
  await assert.rejects(fetch('https://example.invalid/'), /External network is disabled/);
});

test('offline TCP guard rejects both numeric and string remote port calls', () => {
  for (const connect of [socket => socket.connect({ host: 'example.invalid', port: 443 }), socket => socket.connect('443', 'example.invalid')]) {
    const socket = new Socket();
    try { assert.throws(() => connect(socket), /External TCP is disabled/); }
    finally { socket.destroy(); }
  }
});
