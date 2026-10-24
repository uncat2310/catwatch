import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sanitizeProjects, writeJsonAtomic, tokenMatches, readBearerToken } from '../lib/store.js';

test('sanitizeProjects normalizes and strips unknown fields', () => {
  const result = sanitizeProjects([
    { id: 'p-1', title: '  Blog  ', customWanUrl: 'https://blog.example', pingEnabled: false, evil: '<script>' }
  ]);
  assert.equal(sanitizeProjects([{ id: 'a', title: 'A', customWanUrl: 'https://a.example', statusPublic: 'yes' }]).projects[0].statusPublic, false, 'only literal true opts in');
  assert.equal(result.ok, true);
  assert.deepEqual(result.projects, [
    { id: 'p-1', categoryId: 'services', title: 'Blog', customWanUrl: 'https://blog.example/', pingEnabled: false, statusPublic: false }
  ]);
});

test('sanitizeProjects rejects bad input', () => {
  const ok = { id: 'a', title: 'A', customWanUrl: 'https://a.example' };
  assert.equal(sanitizeProjects('nope').error, 'NOT_AN_ARRAY');
  assert.equal(sanitizeProjects([{ ...ok, customWanUrl: 'javascript:alert(1)' }]).error, 'INVALID_URL');
  assert.equal(sanitizeProjects([{ ...ok, id: 'a b' }]).error, 'INVALID_ID');
  assert.equal(sanitizeProjects([{ ...ok, id: '"><img>' }]).error, 'INVALID_ID');
  assert.equal(sanitizeProjects([ok, ok]).error, 'DUPLICATE_ID');
  assert.equal(sanitizeProjects([{ ...ok, title: '   ' }]).error, 'INVALID_TITLE');
  assert.equal(sanitizeProjects(Array.from({ length: 201 }, (_, i) => ({ ...ok, id: `p${i}` }))).error, 'TOO_MANY_PROJECTS');
  assert.equal(sanitizeProjects([]).ok, true, 'empty list is allowed');
});

test('writeJsonAtomic writes and replaces files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
  const file = path.join(dir, 'nested', 'projects.json');
  writeJsonAtomic(file, [1]);
  writeJsonAtomic(file, [2]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), [2]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['projects.json'], 'no temp files left');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('admin token comparison', () => {
  assert.equal(tokenMatches('secret-token', 'secret-token'), true);
  assert.equal(tokenMatches('secret-token', 'secret-tokem'), false);
  assert.equal(tokenMatches('', ''), false, 'disabled admin never matches');
  assert.equal(tokenMatches('secret-token', undefined), false);
  assert.equal(readBearerToken({ headers: { authorization: 'Bearer abc ' } }), 'abc');
  assert.equal(readBearerToken({ headers: {} }), '');
});
