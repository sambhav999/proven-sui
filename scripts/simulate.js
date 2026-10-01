import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { canonicalMessage, commitmentHash, score } from '../server/logic.js';

let seed = 20260929;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const bps = p => Math.max(0, Math.min(10000, Math.round(p * 10000)));
const started = performance.now();

// Outcomes are drawn from known probabilities. This tests calibration and the
// score aggregation over many independent, prospective binary questions.
let calibrated = 0, benchmark = 0, overconfident = 0, randomAgent = 0;
const scenarios = 250, questionsPerScenario = 30;
for (let n = 0; n < scenarios; n++) {
  const truth = Array.from({ length: questionsPerScenario }, () => .08 + random() * .84);
  const outcomes = truth.map(p => random() < p);
  const baseline = truth.map(() => 5000);
  calibrated += score(truth.map(bps), outcomes, baseline).brier;
  benchmark += score(baseline, outcomes, baseline).brier;
  overconfident += score(truth.map(p => bps(p < .5 ? p * .25 : 1 - (1 - p) * .25)), outcomes, baseline).brier;
  randomAgent += score(truth.map(() => bps(random())), outcomes, baseline).brier;
}
assert(calibrated < benchmark && calibrated < overconfident && calibrated < randomAgent);
assert.equal(score([0, 10000], [false, true], [5000, 5000]).brier, 0);
assert.equal(score([0, 10000], [true, false], [5000, 5000]).brier, 1);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proven-simulation-'));
let now = Date.now();
const store = await new Store(dir).init();
const chain = { enabled: false, verifyObject: async () => ({ status: 'not_anchored' }) };
const server = createApp({ store, chain, clock: () => now, env: { ADMIN_TOKEN: 'simulation-token', DEMO_MODE: 'false' } }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let apiCalls = 0;
const request = async (method, route, body, admin = false) => {
  apiCalls++;
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: 'Bearer simulation-token' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
};
const sig = (privateKey, action, parts) => sign(null, Buffer.from(canonicalMessage(action, parts)), privateKey).toString('base64');

try {
  const questions = Array.from({ length: 12 }, (_, i) => ({ text: `Will outcome ${i + 1} be YES at the specified time?`, source: `Fixed public source ${i + 1} and timestamp`, baselineBps: 5000 }));
  const spec = { title: 'Simulation prospective exam', domain: 'SIM', questions,
    cutoffAt: new Date(now + 120000).toISOString(), revealUntil: new Date(now + 240000).toISOString(), resolveAfter: new Date(now + 360000).toISOString() };
  assert.equal((await request('POST', '/api/admin/exams', spec)).status, 401);
  assert.equal((await request('POST', '/api/admin/exams', { ...spec, revealUntil: new Date(now + 60000).toISOString() }, true)).status, 400);
  const created = await request('POST', '/api/admin/exams', spec, true);
  assert.equal(created.status, 201);
  const examId = created.data.id;
  assert.equal((await request('GET', `/api/exams/${examId}`)).data.resolutions, undefined);
  const agents = [];
  for (let i = 0; i < 12; i++) {
    const keys = generateKeyPairSync('ed25519');
    const name = `Simulation Agent ${i}`;
    const model = `sim-v${i}`;
    const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const registered = await request('POST', '/api/agents', { name, modelVersion: model, publicKey, signature: sig(keys.privateKey, 'register', [name, model]) });
    assert.equal(registered.status, 201);
    const values = Array.from({ length: 12 }, () => bps(.1 + random() * .8));
    const salt = randomBytes(32).toString('hex');
    const hash = commitmentHash(values, salt);
    const agentId = registered.data.id;
    const payload = { agentId, hash, signature: sig(keys.privateKey, 'commit', [examId, agentId, hash]) };
    assert.equal((await request('POST', `/api/exams/${examId}/commit`, payload)).status, 201);
    if (i === 0) {
      assert.equal((await request('POST', `/api/exams/${examId}/commit`, payload)).status, 409);
      assert.equal((await request('POST', `/api/exams/${examId}/commit`, { ...payload, signature: sig(keys.privateKey, 'register', [name, model]) })).status, 401);
    }
    agents.push({ agentId, values, salt, hash, keys });
  }
  const first = agents[0];
  const reveal = a => ({ agentId: a.agentId, probabilities: a.values, salt: a.salt, signature: sig(a.keys.privateKey, 'reveal', [examId, a.agentId, a.hash]) });
  assert.equal((await request('POST', `/api/exams/${examId}/reveal`, reveal(first))).status, 409);
  now += 120000; // exact cutoff: no new commits, reveal opens
  assert.equal((await request('POST', `/api/exams/${examId}/commit`, { agentId: first.agentId, hash: first.hash, signature: sig(first.keys.privateKey, 'commit', [examId, first.agentId, first.hash]) })).status, 409);
  assert.equal((await request('POST', `/api/exams/${examId}/reveal`, { ...reveal(first), probabilities: first.values.map((p, i) => i === 0 ? p + 1 : p) })).status, 401);
  assert.equal((await request('POST', `/api/exams/${examId}/reveal`, { ...reveal(first), signature: sig(agents[1].keys.privateKey, 'reveal', [examId, first.agentId, first.hash]) })).status, 401);
  for (let i = 0; i < 9; i++) assert.equal((await request('POST', `/api/exams/${examId}/reveal`, reveal(agents[i]))).status, 200);
  assert.equal((await request('POST', `/api/exams/${examId}/reveal`, reveal(first))).status, 409);
  const resolutions = questions.map((_, i) => ({ outcome: i % 3 !== 0, sourceEvidence: `Timestamped source event ${i}` }));
  assert.equal((await request('POST', `/api/admin/exams/${examId}/resolve`, { resolutions }, true)).status, 409);
  now += 120001; // after reveal deadline, before resolution
  assert.equal((await request('POST', `/api/exams/${examId}/reveal`, reveal(agents[9]))).status, 409);
  now += 120000;
  const resolved = await request('POST', `/api/admin/exams/${examId}/resolve`, { resolutions }, true);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.receipts.length, 9);
  assert.equal(resolved.data.missed.length, 3);
  assert.equal(resolved.data.anchorStatus, 'local-only');
  assert.equal((await request('POST', `/api/admin/exams/${examId}/resolve`, { resolutions }, true)).status, 409);
  for (const id of resolved.data.receipts) {
    const verification = await request('GET', `/api/verify/${id}`);
    assert.equal(verification.status, 200);
    assert.equal(verification.data.signatureValid, true);
    assert.equal(verification.data.commitmentValid, true);
    assert.equal(verification.data.scoreValid, true);
    assert.equal(verification.data.chain.status, 'not_anchored');
  }
  const target = store.state.receipts[0];
  const original = target.probabilities[0];
  target.probabilities[0] = original === 10000 ? 9999 : original + 1;
  const tampered = (await request('GET', `/api/verify/${target.id}`)).data;
  assert.equal(tampered.signatureValid, false);
  assert.equal(tampered.commitmentValid, false);
  assert.equal(tampered.scoreValid, false);
  target.probabilities[0] = original;
  const persisted = await new Store(dir).init();
  assert.equal(persisted.state.receipts.length, 9);
  console.log(JSON.stringify({ result: 'PASS', monteCarlo: { scenarios, questions: scenarios * questionsPerScenario,
    meanBrier: { calibrated: +(calibrated / scenarios).toFixed(4), baseline: +(benchmark / scenarios).toFixed(4), overconfident: +(overconfident / scenarios).toFixed(4), random: +(randomAgent / scenarios).toFixed(4) } },
    lifecycle: { agents: agents.length, questions: questions.length, receipts: resolved.data.receipts.length,
      missedReveals: resolved.data.missed.length, apiCalls, adversarialChecks: 10, anchored: false },
    elapsedMs: Math.round(performance.now() - started) }, null, 2));
} finally {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
}
