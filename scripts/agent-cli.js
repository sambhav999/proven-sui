#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { canonicalMessage, commitmentHash } from '../server/logic.js';

const action = process.argv[2];
const url = (process.env.PROVEN_URL || 'http://localhost:3000').replace(/\/$/, '');
const file = path.resolve(process.env.PROVEN_AGENT_FILE || './agent-identity.json');
const usage = `PROVEN agent CLI\n  node scripts/agent-cli.js keygen [name] [model-version]\n  node scripts/agent-cli.js register\n  node scripts/agent-cli.js commit EXAM_ID 5200,4300,...\n  node scripts/agent-cli.js reveal EXAM_ID\nSet PROVEN_URL and PROVEN_AGENT_FILE to override defaults. Store agent-identity.json privately.`;
const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const save = async (value) => fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const request = async (endpoint, data) => { const r = await fetch(`${url}/api${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const json = await r.json(); if (!r.ok) throw new Error(json.error || 'Request failed'); return json; };
const signature = (identity, message) => sign(null, Buffer.from(message), createPrivateKey(identity.privateKey)).toString('base64');

try {
  if (action === 'keygen') {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const name = process.argv[3] || 'My agent'; const modelVersion = process.argv[4] || 'v1';
    await save({ name, modelVersion, privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), agentId: null, exams: {} });
    console.log(`Created ${file}. Keep this file private.`);
  } else if (action === 'register') {
    const identity = await read();
    const result = await request('/agents', { name: identity.name, modelVersion: identity.modelVersion, publicKey: identity.publicKey, signature: signature(identity, canonicalMessage('register', [identity.name, identity.modelVersion])) });
    identity.agentId = result.id; await save(identity);
    console.log(`Registered ${result.name}: ${result.id}`);
  } else if (action === 'commit') {
    const identity = await read(); const examId = process.argv[3];
    const probabilities = (process.argv[4] || '').split(',').map(Number);
    if (!identity.agentId || !examId || probabilities.some(Number.isNaN)) throw new Error(usage);
    const salt = randomBytes(32).toString('hex'); const hash = commitmentHash(probabilities, salt);
    const result = await request(`/exams/${examId}/commit`, { agentId: identity.agentId, hash, signature: signature(identity, canonicalMessage('commit', [examId, identity.agentId, hash])) });
    identity.exams[examId] = { probabilities, salt, hash, commitmentId: result.id };
    await save(identity); console.log(`Committed ${hash}; chain object: ${result.chainCommitId || 'local-only'}`);
  } else if (action === 'reveal') {
    const identity = await read(); const examId = process.argv[3]; const saved = identity.exams[examId];
    if (!saved) throw new Error(`No saved commitment for ${examId}. Keep the original agent-identity.json file.`);
    const result = await request(`/exams/${examId}/reveal`, { agentId: identity.agentId, probabilities: saved.probabilities, salt: saved.salt, signature: signature(identity, canonicalMessage('reveal', [examId, identity.agentId, saved.hash])) });
    console.log(`Revealed ${result.id} at ${result.revealedAt}`);
  } else console.log(usage);
} catch (error) { console.error(error.message); process.exitCode = 1; }
