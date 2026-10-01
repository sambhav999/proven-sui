import express from 'express';
import path from 'node:path';
import { createPrivateKey, sign, verify } from 'node:crypto';
import { commitmentHash, canonicalMessage, sha256, uuid, verifyAgent, score, publicExam, validateExam, assert } from './logic.js';

const locked = (exam, now) => now >= Date.parse(exam.cutoffAt);
const receiptPayload = (r) => JSON.stringify({ id: r.id, examId: r.examId, agentId: r.agentId, modelVersion: r.modelVersion, probabilities: r.probabilities, outcomes: r.outcomes, score: r.score, questionDigest: r.questionDigest, resolutionDigest: r.resolutionDigest, commitHash: r.commitHash, committedAt: r.committedAt, revealedAt: r.revealedAt, resolvedAt: r.resolvedAt });
const safeAgent = (agent) => { const { publicKey, ...rest } = agent; return { ...rest, publicKey: publicKey ? `${publicKey.slice(0, 18)}…` : null }; };

export function createApp({ store, chain, env = process.env, clock = () => Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '80kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
    next();
  });
  const admin = (req, _res, next) => {
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN === 'replace-with-a-long-random-secret') return next(Object.assign(new Error('Set a strong ADMIN_TOKEN before managing exams'), { status: 503 }));
    if (req.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return next(Object.assign(new Error('Invalid admin token'), { status: 401 }));
    next();
  };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const getExam = (id) => { const exam = store.state.exams.find(e => e.id === id); assert(exam, 'Exam not found', 404); return exam; };
  const getAgent = (id) => { const agent = store.state.agents.find(a => a.id === id); assert(agent, 'Agent not found', 404); return agent; };

  app.get('/healthz', (_req, res) => res.json({ ok: true, mode: chain.enabled ? 'sui-anchored' : 'local' }));
  app.get('/api/meta', (_req, res) => res.json({ demoMode: env.DEMO_MODE === 'true', suiAnchoring: chain.enabled, network: chain.enabled ? chain.network : null, packageId: chain.packageId || null, issuerPublicKey: store.state.issuerPublicKey, version: '0.2.0' }));
  app.get('/api/exams', (_req, res) => res.json([...store.state.exams].sort((a,b) => Number(a.demo) - Number(b.demo) || Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(e => ({ ...publicExam(e), entryCount: store.state.entries.filter(x => x.examId === e.id).length }))));
  app.get('/api/exams/:id', (req, res) => {
    const exam = getExam(req.params.id);
    const entries = store.state.entries.filter(e => e.examId === exam.id);
    res.json({ ...publicExam(exam), entryCount: entries.length, leaderboard: exam.status === 'resolved' ? store.state.receipts.filter(r => r.examId === exam.id).sort((a, b) => a.score.brier - b.score.brier).map(r => ({ id: r.id, agentId: r.agentId, agentName: r.agentName, brier: r.score.brier, benchmarkBrier: r.score.benchmarkBrier, count: r.score.count, demo: r.demo, chainObjectId: r.chainObjectId })) : [], missed: exam.status === 'resolved' ? entries.filter(e => !e.revealedAt).map(e => ({ agentId: e.agentId, agentName: store.state.agents.find(a => a.id === e.agentId)?.name || 'Unknown', committedAt: e.committedAt })) : [] });
  });
  app.get('/api/agents', (_req, res) => res.json(store.state.agents.map(a => ({ ...safeAgent(a), receipts: store.state.receipts.filter(r => r.agentId === a.id).length }))));
  app.get('/api/agents/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    const receipts = store.state.receipts.filter(r => r.agentId === agent.id);
    const genuine = receipts.filter(r => !r.demo);
    const domains = [...new Set(genuine.map(r => store.state.exams.find(e => e.id === r.examId)?.domain))];
    const snapshots = domains.map(domain => {
      const rows = genuine.filter(r => store.state.exams.find(e => e.id === r.examId)?.domain === domain);
      const count = rows.reduce((n,r) => n + r.score.count, 0);
      return { domain, modelVersion: agent.modelVersion, resolvedCount: count, brier: rows.reduce((n,r) => n + r.score.sum, 0) / count / 1e8, benchmarkBrier: rows.reduce((n,r) => n + r.score.benchmarkSum, 0) / count / 1e8, evidence: rows.map(r => r.id), status: count < 30 ? 'limited sample' : 'observed' };
    });
    const missed = store.state.entries.filter(e => e.agentId === agent.id && store.state.exams.find(x => x.id === e.examId)?.status === 'resolved' && !e.revealedAt).map(e => ({ examId: e.examId, committedAt: e.committedAt }));
    res.json({ ...safeAgent(agent), snapshots, missed, receipts: receipts.map(r => ({ id: r.id, examId: r.examId, brier: r.score.brier, count: r.score.count, demo: r.demo, chainObjectId: r.chainObjectId })) });
  });
  app.get('/api/agents/:id/competence', (req, res) => {
    const agent = getAgent(req.params.id);
    const domain = String(req.query.domain || '');
    assert(domain, 'Specify ?domain=EXACT_DOMAIN');
    const receipts = store.state.receipts.filter(r => r.agentId === agent.id && !r.demo && store.state.exams.find(e => e.id === r.examId)?.domain === domain);
    const count = receipts.reduce((n,r) => n + r.score.count, 0);
    const missed = store.state.entries.filter(e => e.agentId === agent.id && !e.revealedAt && store.state.exams.find(x => x.id === e.examId)?.status === 'resolved' && store.state.exams.find(x => x.id === e.examId)?.domain === domain).length;
    res.json({ agentId: agent.id, modelVersion: agent.modelVersion, domain, resolvedCount: count, missedExams: missed, brier: count ? receipts.reduce((n,r) => n + r.score.sum, 0) / count / 1e8 : null, benchmarkBrier: count ? receipts.reduce((n,r) => n + r.score.benchmarkSum, 0) / count / 1e8 : null, receiptIds: receipts.map(r => r.id), evidenceLevel: count < 30 ? 'limited sample' : 'observed', caveat: 'A forecasting score does not certify general competence, model provenance, or safe trading.' });
  });

  app.post('/api/agents', wrap(async (req, res) => {
    const { name, role, bio, modelVersion, publicKey, signature } = req.body;
    const n = String(name || '').trim();
    const version = String(modelVersion || '').trim();
    assert(n.length >= 2 && n.length <= 40 && version.length >= 2 && version.length <= 80, 'Name or model version is invalid');
    assert(typeof publicKey === 'string' && publicKey.length < 300, 'Ed25519 public key is required');
    assert(verifyAgent(publicKey, canonicalMessage('register', [n, version]), signature), 'Registration signature is invalid', 401);
    const agent = await store.mutate(state => {
      assert(!state.agents.some(a => a.publicKey === publicKey), 'This key is already registered', 409);
      const kind = req.body.kind === 'human' ? 'human' : 'agent';
      const created = { id: uuid(), name: n, kind, role: kind === 'human' ? 'Human participant' : String(role || 'Independent agent').slice(0, 80), bio: String(bio || '').slice(0, 240), modelVersion: version, publicKey, createdAt: new Date(clock()).toISOString(), demo: false, color: kind === 'human' ? '#ffb876' : '#b8f260' };
      state.agents.push(created); return created;
    });
    res.status(201).json(safeAgent(agent));
  }));

  app.post('/api/admin/exams', admin, wrap(async (req, res) => {
    const exam = validateExam(req.body, clock());
    if (chain.enabled) {
      const linked = await chain.createExam(exam);
      exam.chainExamId = linked.objectId;
      exam.chainCreateDigest = linked.digest;
    }
    await store.mutate(state => { state.exams.push(exam); });
    res.status(201).json(publicExam(exam));
  }));

  app.post('/api/exams/:id/commit', wrap(async (req, res) => {
    const { agentId, hash, signature } = req.body;
    const exam = getExam(req.params.id);
    const agent = getAgent(agentId);
    assert(!exam.demo && exam.status === 'open' && !locked(exam, clock()), 'Commit window is closed', 409);
    assert(agent.publicKey && typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash), 'Invalid commitment');
    assert(verifyAgent(agent.publicKey, canonicalMessage('commit', [exam.id, agent.id, hash.toLowerCase()]), signature), 'Invalid agent signature', 401);
    const entry = await store.mutate(async state => {
      assert(!state.entries.some(x => x.examId === exam.id && x.agentId === agent.id), 'Agent already committed to this exam', 409);
      const created = { id: uuid(), examId: exam.id, agentId: agent.id, modelHash: sha256(agent.modelVersion), hash: hash.toLowerCase(), committedAt: new Date(clock()).toISOString(), revealedAt: null, probabilities: null, salt: null, chainCommitId: null, chainDigest: null };
      if (chain.enabled) {
        const linked = await chain.commit(exam, created);
        created.chainCommitId = linked.objectId;
        created.chainDigest = linked.digest;
      }
      state.entries.push(created); return created;
    });
    res.status(201).json({ id: entry.id, examId: exam.id, committedAt: entry.committedAt, hash: entry.hash, chainCommitId: entry.chainCommitId, chainDigest: entry.chainDigest });
  }));

  app.post('/api/exams/:id/reveal', wrap(async (req, res) => {
    const { agentId, probabilities, salt, signature } = req.body;
    const exam = getExam(req.params.id);
    const agent = getAgent(agentId);
    assert(!exam.demo && locked(exam, clock()) && clock() <= Date.parse(exam.revealUntil) && exam.status === 'open', 'Reveal window is closed', 409);
    assert(Array.isArray(probabilities) && probabilities.length === exam.questions.length, 'Reveal must cover every question');
    const hash = commitmentHash(probabilities, salt);
    assert(verifyAgent(agent.publicKey, canonicalMessage('reveal', [exam.id, agent.id, hash]), signature), 'Invalid agent signature', 401);
    const entry = await store.mutate(state => {
      const existing = state.entries.find(x => x.examId === exam.id && x.agentId === agent.id);
      assert(existing && !existing.revealedAt && existing.hash === hash, 'No matching unrevealed commitment', 409);
      existing.probabilities = probabilities; existing.salt = salt.toLowerCase(); existing.revealedAt = new Date(clock()).toISOString(); return existing;
    });
    res.json({ id: entry.id, revealedAt: entry.revealedAt, accepted: true });
  }));

  app.post('/api/admin/exams/:id/resolve', admin, wrap(async (req, res) => {
    const exam = getExam(req.params.id);
    assert(!exam.demo && exam.status === 'open' && clock() >= Date.parse(exam.resolveAfter), 'Exam cannot resolve yet', 409);
    const rows = req.body.resolutions;
    assert(Array.isArray(rows) && rows.length === exam.questions.length, 'Provide one resolution per question');
    const resolutions = rows.map((r, i) => {
      assert(typeof r.outcome === 'boolean' && typeof r.sourceEvidence === 'string' && r.sourceEvidence.trim().length >= 4 && r.sourceEvidence.length <= 500, `Question ${i + 1} needs outcome and evidence`);
      return { questionId: exam.questions[i].id, outcome: r.outcome, sourceEvidence: r.sourceEvidence.trim() };
    });
    const produced = await store.mutate(state => {
      const actual = state.exams.find(e => e.id === exam.id);
      assert(actual.status === 'open', 'Already resolved', 409);
      actual.resolutions = resolutions; actual.status = 'resolved'; actual.resolvedAt = new Date(clock()).toISOString();
      const created = [];
      for (const entry of state.entries.filter(e => e.examId === exam.id && e.revealedAt)) {
        const agent = state.agents.find(a => a.id === entry.agentId);
        const r = { id: uuid(), examId: exam.id, agentId: entry.agentId, agentName: agent.name, modelVersion: agent.modelVersion, probabilities: entry.probabilities, outcomes: resolutions.map(x => x.outcome), score: score(entry.probabilities, resolutions.map(x => x.outcome), exam.questions.map(q => q.baselineBps)), questionDigest: exam.questionDigest, resolutionDigest: sha256(JSON.stringify(resolutions)), commitHash: entry.hash, committedAt: entry.committedAt, revealedAt: entry.revealedAt, resolvedAt: actual.resolvedAt, demo: false, chainObjectId: null, chainDigest: null, anchorError: null };
        r.signature = sign(null, Buffer.from(receiptPayload(r)), createPrivateKey(state.issuerPrivateKey)).toString('base64');
        state.receipts.push(r); created.push(r.id);
      }
      return created;
    });
    // Anchor retries are explicit, making a chain outage visible instead of
    // silently claiming a receipt was published.
    res.json({ resolved: true, receipts: produced, missed: store.state.entries.filter(e => e.examId === exam.id && !e.revealedAt).map(e => e.agentId), anchorStatus: chain.enabled ? 'pending; call admin anchor endpoint' : 'local-only' });
  }));

  app.post('/api/admin/receipts/:id/anchor', admin, wrap(async (req, res) => {
    assert(chain.enabled, 'Sui anchoring is not configured', 409);
    const r = store.state.receipts.find(x => x.id === req.params.id);
    assert(r && !r.demo, 'Receipt not found', 404);
    if (r.chainObjectId) return res.json({ objectId: r.chainObjectId, digest: r.chainDigest });
    const exam = getExam(r.examId);
    const entry = store.state.entries.find(e => e.examId === r.examId && e.agentId === r.agentId);
    const result = await chain.result(exam, entry, r);
    await store.mutate(state => { const item = state.receipts.find(x => x.id === r.id); item.chainObjectId = result.objectId; item.chainDigest = result.digest; item.anchorError = null; });
    res.json(result);
  }));

  app.get('/api/receipts/:id', (req, res) => {
    const receipt = store.state.receipts.find(r => r.id === req.params.id);
    assert(receipt, 'Receipt not found', 404);
    res.json({ ...receipt, exam: publicExam(getExam(receipt.examId)) });
  });
  app.get('/api/verify/:id', wrap(async (req, res) => {
    const receipt = store.state.receipts.find(r => r.id === req.params.id);
    assert(receipt, 'Receipt not found', 404);
    const exam = getExam(receipt.examId);
    if (receipt.demo) return res.json({ demo: true, signatureValid: false, commitmentValid: false, scoreValid: true, chain: { status: 'not_anchored' }, message: 'Illustrative sample only; this is not a verified forecast.' });
    const entry = store.state.entries.find(e => e.examId === receipt.examId && e.agentId === receipt.agentId);
    const signatureValid = verify(null, Buffer.from(receiptPayload(receipt)), store.state.issuerPublicKey, Buffer.from(receipt.signature || '', 'base64'));
    const commitmentValid = Boolean(entry && entry.hash === receipt.commitHash && commitmentHash(receipt.probabilities, entry.salt) === receipt.commitHash && Date.parse(entry.committedAt) < Date.parse(exam.cutoffAt) && Date.parse(entry.revealedAt) >= Date.parse(exam.cutoffAt));
    const check = score(receipt.probabilities, exam.resolutions.map(x => x.outcome), exam.questions.map(q => q.baselineBps));
    const scoreValid = check.sum === receipt.score.sum && check.benchmarkSum === receipt.score.benchmarkSum && receipt.questionDigest === exam.questionDigest && receipt.resolutionDigest === sha256(JSON.stringify(exam.resolutions));
    res.json({ demo: false, signatureValid, commitmentValid, scoreValid, chain: await chain.verifyObject(receipt.chainObjectId, receipt), caveat: 'The exam operator selects questions and resolves outcomes from the published source. Agent model provenance is not attested.' });
  }));

  const dist = path.resolve('dist');
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('{*path}', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(dist, 'index.html'), err => err && next(err)));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' }));
  return app;
}
