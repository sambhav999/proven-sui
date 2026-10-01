import { createHash } from 'node:crypto';
import { score, uuid } from './logic.js';

const digest = (s) => createHash('sha256').update(s).digest('hex');

export function seedDemo(state) {
  if (state.exams.length) return;
  const questions = [
    ['Did BTC settle above the reference level in session 01?', 5400, true],
    ['Did BTC settle above the reference level in session 02?', 4700, false],
    ['Did BTC settle above the reference level in session 03?', 5100, true],
    ['Did BTC settle above the reference level in session 04?', 6200, true],
    ['Did BTC settle above the reference level in session 05?', 3900, false],
    ['Did BTC settle above the reference level in session 06?', 5800, false],
    ['Did BTC settle above the reference level in session 07?', 4400, true],
    ['Did BTC settle above the reference level in session 08?', 5200, false],
  ];
  const examId = uuid();
  const exam = {
    id: examId, title: 'The Signal Test · Sample', domain: 'BTC outcomes',
    description: 'Illustrative results that let you explore the product. They are not live forecasts or proof of agent performance.',
    createdAt: new Date(Date.now() - 86400000 * 6).toISOString(),
    cutoffAt: new Date(Date.now() - 86400000 * 5).toISOString(),
    revealUntil: new Date(Date.now() - 86400000 * 4).toISOString(),
    resolveAfter: new Date(Date.now() - 86400000 * 3).toISOString(),
    questions: questions.map(([text, baselineBps], i) => ({ id: `q${i + 1}`, text, source: 'Illustrative fixture; no external price feed', baselineBps })),
    questionDigest: digest(JSON.stringify(questions)), status: 'resolved', chainExamId: null,
    resolutions: questions.map(([, , outcome], i) => ({ questionId: `q${i + 1}`, outcome, sourceEvidence: 'Illustrative fixture' })), demo: true,
  };
  state.exams.push(exam);
  const agents = [
    ['ATHENA', 'Pattern research agent', 'A careful forecaster that leans into context.', [7300, 2800, 6900, 7500, 2400, 4900, 6200, 3500], '#b8f260'],
    ['VECTOR', 'Market signal agent', 'Fast conviction with stronger peaks and misses.', [8200, 4500, 7400, 8100, 2300, 6500, 3600, 2300], '#9a8dff'],
    ['NOVA', 'General purpose agent', 'A balanced baseline across changing conditions.', [5700, 4300, 5500, 5900, 4500, 4800, 5000, 4400], '#ffb876'],
  ];
  for (const [name, role, bio, probabilities, color] of agents) {
    const agent = { id: uuid(), name, role, bio, color, modelVersion: 'sample-v1', publicKey: null, createdAt: exam.createdAt, demo: true };
    state.agents.push(agent);
    const s = score(probabilities, exam.resolutions.map(r => r.outcome), exam.questions.map(q => q.baselineBps));
    const receipt = { id: uuid(), examId, agentId: agent.id, agentName: name, modelVersion: 'sample-v1', probabilities, outcomes: exam.resolutions.map(r => r.outcome), score: s, questionDigest: exam.questionDigest, resolutionDigest: digest(JSON.stringify(exam.resolutions)), commitHash: null, committedAt: exam.cutoffAt, revealedAt: exam.revealUntil, resolvedAt: exam.resolveAfter, demo: true, chainObjectId: null, chainDigest: null, anchorError: null, signature: null };
    state.receipts.push(receipt);
  }
}
