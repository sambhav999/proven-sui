import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const uuid = () => randomUUID();

export function assert(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}

export function canonicalMessage(action, parts) {
  return ['PROVEN_V1', action, ...parts].join('|');
}

export function verifyAgent(publicKey, message, signature) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

// Sui Move hashes the same BCS vector<u16> || salt bytes. The ULEB128 prefix
// is the vector length; u16 values are little endian.
export function probabilitiesBytes(values) {
  assert(Array.isArray(values) && values.length > 0 && values.length <= 100, 'Expected 1–100 probabilities');
  const len = [];
  let n = values.length;
  do { const byte = n & 0x7f; n >>>= 7; len.push(byte | (n ? 0x80 : 0)); } while (n);
  const body = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => {
    assert(Number.isInteger(value) && value >= 0 && value <= 10000, 'Probability must be an integer from 0 to 10000 bps');
    body.writeUInt16LE(value, i * 2);
  });
  return Buffer.concat([Buffer.from(len), body]);
}

export function commitmentHash(values, saltHex) {
  assert(typeof saltHex === 'string' && /^[a-f0-9]{64}$/i.test(saltHex), 'Salt must be 32 random bytes in hex');
  return sha256(Buffer.concat([probabilitiesBytes(values), Buffer.from(saltHex, 'hex')]));
}

export function score(probabilities, outcomes, baseline) {
  assert(probabilities.length === outcomes.length && outcomes.length === baseline.length, 'Incomplete question slate');
  let sum = 0;
  let benchmarkSum = 0;
  const details = probabilities.map((p, i) => {
    const y = outcomes[i] ? 10000 : 0;
    const squaredError = (p - y) ** 2;
    const benchmarkError = (baseline[i] - y) ** 2;
    sum += squaredError;
    benchmarkSum += benchmarkError;
    return { probabilityBps: p, outcome: outcomes[i], squaredError, benchmarkError };
  });
  return { sum, benchmarkSum, count: outcomes.length, brier: sum / (outcomes.length * 1e8), benchmarkBrier: benchmarkSum / (outcomes.length * 1e8), details };
}

export function publicExam(exam) {
  const { resolutions, ...rest } = exam;
  return { ...rest, resolutions: exam.status === 'resolved' ? resolutions : undefined };
}

export function validateExam(body, now = Date.now()) {
  const title = String(body.title || '').trim();
  const domain = String(body.domain || '').trim();
  const questions = body.questions;
  const cutoffAt = Date.parse(body.cutoffAt);
  const revealUntil = Date.parse(body.revealUntil);
  const resolveAfter = Date.parse(body.resolveAfter);
  assert(title.length >= 5 && title.length <= 100, 'Title must be 5–100 characters');
  assert(domain.length >= 2 && domain.length <= 40, 'Domain must be 2–40 characters');
  assert(Array.isArray(questions) && questions.length >= 2 && questions.length <= 30, 'Exam needs 2–30 fixed questions');
  assert(Number.isFinite(cutoffAt) && cutoffAt > now + 60000, 'Cutoff must be at least one minute in the future');
  assert(Number.isFinite(revealUntil) && revealUntil > cutoffAt && Number.isFinite(resolveAfter) && resolveAfter > revealUntil, 'Require cutoff < reveal deadline < resolution');
  const normalized = questions.map((q, i) => {
    const text = String(q.text || '').trim();
    const source = String(q.source || '').trim();
    assert(text.length >= 8 && text.length <= 300, `Question ${i + 1} needs 8–300 characters`);
    assert(source.length >= 4 && source.length <= 300, `Question ${i + 1} needs a specified resolution source`);
    assert(Number.isInteger(q.baselineBps) && q.baselineBps >= 0 && q.baselineBps <= 10000, `Question ${i + 1} baseline must be 0–10000 bps`);
    return { id: `q${i + 1}`, text, source, baselineBps: q.baselineBps };
  });
  return { id: uuid(), title, domain, description: String(body.description || '').slice(0, 400), createdAt: new Date(now).toISOString(), cutoffAt: new Date(cutoffAt).toISOString(), revealUntil: new Date(revealUntil).toISOString(), resolveAfter: new Date(resolveAfter).toISOString(), questions: normalized, questionDigest: sha256(JSON.stringify(normalized)), status: 'open', chainExamId: null, resolutions: null, demo: false };
}
