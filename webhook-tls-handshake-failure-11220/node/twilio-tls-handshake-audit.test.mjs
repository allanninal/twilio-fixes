import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeOf, listener, sweep, verdict } from './twilio-tls-handshake-audit.mjs';

const alert = (sid, url, code = '11220') => ({
  sid, request_url: url, error_code: code, date_generated: '2026-05-05T14:08:00Z',
});

test('listener always writes the port out', () => {
  assert.equal(listener('https://hooks.example.com/voice'), 'hooks.example.com:443');
  assert.equal(listener('https://Hooks.Example.com:8443/voice'), 'hooks.example.com:8443');
  assert.equal(listener('http://hooks.example.com/voice'), 'hooks.example.com:80');
  assert.equal(listener('not a url'), '');
  assert.equal(listener(null), '');
});

test('codeOf reads the string the Monitor API returns', () => {
  assert.equal(codeOf({ error_code: '11220' }), 11220);
  assert.equal(codeOf({ error_code: 11220 }), 11220);
  assert.equal(codeOf({ error_code: '' }), null);
  assert.equal(codeOf({}), null);
});

test('sweep drops listeners with no handshake failure', () => {
  const rows = sweep([
    alert('A1', 'https://a.example.com/voice'),
    alert('A2', 'https://b.example.com/voice', '11200'),
    alert('A3', 'https://a.example.com:8443/voice'),
  ]);
  assert.deepEqual([...rows.keys()].sort(), ['a.example.com:443', 'a.example.com:8443']);
});

test('two ports on one host are two listeners', () => {
  const rows = sweep([
    alert('A1', 'https://a.example.com/voice'),
    alert('A2', 'https://a.example.com:8443/voice'),
  ]);
  assert.equal(rows.get('a.example.com:443').codes[11220], 1);
  assert.equal(rows.get('a.example.com:8443').codes[11220], 1);
});

test('a certificate code beside it means the handshake got further', () => {
  const [state, detail] = verdict({ codes: { 11220: 40, 11236: 12 } });
  assert.equal(state, 'certificate-first');
  assert.match(detail, /11236/);
});

test('a code that needed a response means one stale node', () => {
  const [state, detail] = verdict({ codes: { 11220: 9, 11200: 300 } });
  assert.equal(state, 'one-node');
  assert.match(detail, /balancer/);
});

test('only 11220 is the plain protocol mismatch', () => {
  const [state, detail] = verdict({ codes: { 11220: 512 } });
  assert.equal(state, 'no-shared-parameters');
  assert.match(detail, /cipher suite/);
});

test('no handshake failures is clean', () => {
  assert.equal(verdict({ codes: { 11200: 4 } })[0], 'clean');
  assert.equal(verdict({})[0], 'clean');
});
