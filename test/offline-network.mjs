// Test-process guard only: a missing mock must fail locally, never contact a model service.
import { Socket } from 'node:net';

const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!loopback(url.hostname)) throw new Error('External network is disabled in offline tests; inject a mock');
  return originalFetch(input, init);
};

const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : undefined;
  // Unix-domain IPC and pipe fixtures stay local. TCP is restricted to loopback.
  if (!options?.path && (typeof first !== 'string' || /^\d+$/.test(first))) {
    const host = options?.host ?? (typeof args[1] === 'string' ? args[1] : 'localhost');
    if (!loopback(host)) throw new Error('External TCP is disabled in offline tests; inject a mock');
  }
  return connect.apply(this, args);
};
