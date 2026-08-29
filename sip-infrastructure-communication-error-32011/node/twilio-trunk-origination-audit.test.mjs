import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sipHost, transportOf, verdict } from './twilio-trunk-origination-audit.mjs';

test('sipHost ignores scheme, port and parameters', () => {
  assert.equal(sipHost('sip:PBX.example.com:5060;transport=udp'), 'pbx.example.com');
  assert.equal(sipHost('sips:pbx.example.com'), 'pbx.example.com');
  assert.equal(sipHost('sip:trunk@pbx.example.com'), 'pbx.example.com');
  // A bare host is not a SIP URI, so it reduces to nothing and gets reported.
  assert.equal(sipHost('pbx.example.com'), '');
  assert.equal(sipHost(''), '');
});

test('transport is read from the parameter or the scheme', () => {
  assert.equal(transportOf('sip:pbx.example.com;transport=TLS'), 'tls');
  assert.equal(transportOf('sips:pbx.example.com'), 'tls');
  assert.equal(transportOf('sip:pbx.example.com;transport=tcp'), 'tcp');
  assert.equal(transportOf('sip:pbx.example.com'), '');
});

test('no enabled uri is the first thing reported', () => {
  const [state, detail] = verdict({}, [{ sip_url: 'sip:a.example.com', enabled: false }], 9);
  assert.equal(state, 'no-enabled-uri');
  assert.match(detail, /9 alert/);
});

test('three uris on one host is not redundancy', () => {
  const origination = [
    { sip_url: 'sip:pbx.example.com:5060', enabled: true, priority: 10 },
    { sip_url: 'sip:pbx.example.com:5061', enabled: true, priority: 20 },
    { sip_url: 'sip:PBX.example.com;transport=tcp', enabled: true, priority: 30 },
  ];
  const [state, detail] = verdict({}, origination, 4);
  assert.equal(state, 'one-host');
  assert.match(detail, /pbx.example.com/);
});

test('secure trunk with no tls uri fails every call', () => {
  const origination = [
    { sip_url: 'sip:a.example.com;transport=udp', enabled: true, priority: 10 },
    { sip_url: 'sip:b.example.com;transport=udp', enabled: true, priority: 20 },
  ];
  const [state, detail] = verdict({ secure: true }, origination, 0);
  assert.equal(state, 'transport-mismatch');
  assert.match(detail, /every call/);
});

test('a secure trunk with one tls uri is not a mismatch', () => {
  const origination = [{ sip_url: 'sips:a.example.com', enabled: true, priority: 10 },
                       { sip_url: 'sip:b.example.com', enabled: true, priority: 20 }];
  assert.equal(verdict({ secure: true }, origination, 0)[0], 'redundant');
});

test('one enabled uri carries the alert count', () => {
  const origination = [{ sip_url: 'sip:a.example.com', enabled: true, priority: 10 },
                       { sip_url: 'sip:b.example.com', enabled: false, priority: 20 }];
  const [state, detail] = verdict({}, origination, 12);
  assert.equal(state, 'single-path');
  assert.match(detail, /12 alert/);
});

test('equal priorities are load balancing not failover', () => {
  const origination = [{ sip_url: 'sip:a.example.com', enabled: true, priority: 10 },
                       { sip_url: 'sip:b.example.com', enabled: true, priority: 10 }];
  const [state, detail] = verdict({}, origination, 0);
  assert.equal(state, 'flat-priority');
  assert.match(detail, /not failover/);
});

test('a good topology with alerts points at the edge', () => {
  const origination = [{ sip_url: 'sip:a.example.com', enabled: true, priority: 10 },
                       { sip_url: 'sip:b.example.com', enabled: true, priority: 20 }];
  const [state, detail] = verdict({}, origination, 31);
  assert.equal(state, 'reachability');
  assert.match(detail, /TLS version/);
});

test('a malformed uri is reported rather than silently dropped', () => {
  const origination = [{ sip_url: 'pbx.example.com', enabled: true, priority: 10 },
                       { sip_url: 'sip:b.example.com', enabled: true, priority: 20 }];
  assert.equal(verdict({}, origination, 0)[0], 'unparseable-uri');
});
