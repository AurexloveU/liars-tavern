import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const guard = scripts.find((match) => !/\bsrc\s*=|type\s*=/.test(match[1]) && match[2].includes("'file:'"));

test('opening the HTML file redirects to solo play without carrying an old room number', () => {
  assert.ok(guard, 'a classic inline entry guard must run without module loading');
  assert.ok(guard.index < html.indexOf('<script src="./socket.io/socket.io.js"'));
  const destinations = [];
  vm.runInNewContext(guard[2], { window: { location: {
    protocol: 'file:', search: '?room=ABC234', hash: '',
    replace: (url) => destinations.push(url),
  } } });
  assert.deepEqual(destinations, ['http://127.0.0.1:3280/']);
  assert.match(html, /<noscript>[\s\S]*href="http:\/\/127\.0\.0\.1:3280\/"/);
});

test('HTTP and HTTPS retain their server and clean old room links without navigating', () => {
  for (const protocol of ['http:', 'https:']) {
    const cleaned = [];
    vm.runInNewContext(guard[2], { window: { location: {
      protocol, pathname: '/tavern/', search: '?room=ABC234', hash: '',
      replace: () => assert.fail('a working game page must not redirect'),
    }, history: { replaceState: (_state, _title, url) => cleaned.push(url) } } });
    assert.deepEqual(cleaned, ['/tavern/']);
  }
});
