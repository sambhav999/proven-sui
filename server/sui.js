import { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { sha256 } from './logic.js';

const CLOCK = '0x6';
const hexBytes = (hex) => Array.from(Buffer.from(hex, 'hex'));
const FULLNODES = { mainnet: 'https://fullnode.mainnet.sui.io:443', testnet: 'https://fullnode.testnet.sui.io:443', devnet: 'https://fullnode.devnet.sui.io:443' };
const Receipt = bcs.struct('ExperienceReceipt', {
  id: bcs.Address, exam: bcs.Address, commitment: bcs.Address,
  agent_id: bcs.vector(bcs.u8()), model_hash: bcs.vector(bcs.u8()),
  question_digest: bcs.vector(bcs.u8()), resolution_digest: bcs.vector(bcs.u8()),
  score_sum: bcs.u64(), baseline_sum: bcs.u64(), count: bcs.u64(),
  committed_ms: bcs.u64(), resolved_ms: bcs.u64(),
});

export class SuiAnchor {
  constructor(env = process.env) {
    this.enabled = Boolean(env.SUI_PACKAGE_ID && env.SUI_PRIVATE_KEY);
    this.network = env.SUI_NETWORK || 'testnet';
    this.packageId = env.SUI_PACKAGE_ID;
    if (!this.enabled) return;
    const decoded = decodeSuiPrivateKey(env.SUI_PRIVATE_KEY);
    this.signer = Ed25519Keypair.fromSecretKey(decoded.secretKey);
    this.client = new SuiGrpcClient({ network: this.network, baseUrl: env.SUI_RPC_URL || FULLNODES[this.network] });
  }

  async execute(tx) {
    const response = await this.client.signAndExecuteTransaction({ transaction: tx, signer: this.signer, include: { effects: true, objectTypes: true } });
    const done = response.Transaction ?? response.FailedTransaction;
    if (!response.Transaction || !done.status.success) throw new Error(`Sui transaction failed: ${JSON.stringify(done?.status?.error) || done?.digest}`);
    await this.client.waitForTransaction({ digest: done.digest });
    return done;
  }

  created(result, typeSuffix) {
    const change = result.effects.changedObjects.find(o => o.idOperation === 'Created' && result.objectTypes[o.objectId]?.endsWith(typeSuffix));
    return change?.objectId;
  }

  async createExam(exam) {
    if (!this.enabled) return null;
    const tx = new Transaction();
    tx.moveCall({ target: `${this.packageId}::proven::create_exam`, arguments: [
      tx.pure.vector('u8', hexBytes(exam.questionDigest)),
      tx.pure.vector('u16', exam.questions.map(q => q.baselineBps)),
      tx.pure.u64(Date.parse(exam.cutoffAt)), tx.pure.u64(Date.parse(exam.revealUntil)),
      tx.pure.u64(Date.parse(exam.resolveAfter)), tx.object(CLOCK),
    ] });
    const result = await this.execute(tx);
    const created = this.created(result, '::proven::Exam');
    if (!created) throw new Error('Sui exam transaction did not return an Exam object');
    return { objectId: created, digest: result.digest };
  }

  async commit(exam, entry) {
    if (!this.enabled) return null;
    const tx = new Transaction();
    tx.moveCall({ target: `${this.packageId}::proven::commit`, arguments: [
      tx.object(exam.chainExamId), tx.pure.vector('u8', hexBytes(entry.hash)),
      tx.pure.vector('u8', Buffer.from(entry.agentId, 'utf8')),
      tx.pure.vector('u8', hexBytes(entry.modelHash)), tx.object(CLOCK),
    ] });
    const result = await this.execute(tx);
    const created = this.created(result, '::proven::Commitment');
    if (!created) throw new Error('Sui commit transaction did not return a Commitment object');
    return { objectId: created, digest: result.digest };
  }

  async result(exam, entry, receipt) {
    if (!this.enabled) return null;
    const tx = new Transaction();
    tx.moveCall({ target: `${this.packageId}::proven::record_result`, arguments: [
      tx.object(exam.chainExamId), tx.object(entry.chainCommitId),
      tx.pure.vector('u16', entry.probabilities),
      tx.pure.vector('u8', hexBytes(entry.salt)),
      tx.pure.vector('bool', exam.resolutions.map(r => r.outcome)),
      tx.pure.vector('u8', hexBytes(receipt.resolutionDigest)), tx.object(CLOCK),
    ] });
    const result = await this.execute(tx);
    const created = this.created(result, '::proven::ExperienceReceipt');
    if (!created) throw new Error('Sui result transaction did not return an ExperienceReceipt object');
    return { objectId: created, digest: result.digest };
  }

  async verifyObject(objectId, expected) {
    if (!this.enabled || !objectId) return { status: 'not_anchored' };
    try {
      const { object } = await this.client.getObject({ objectId, include: { content: true } });
      if (!object?.content || !object.type.endsWith('::proven::ExperienceReceipt')) return { status: 'unavailable', objectId };
      const f = Receipt.parse(object.content);
      const bytes = v => Buffer.from(v).toString('hex');
      const linked = Number(f.score_sum) === expected.score.sum && Number(f.baseline_sum) === expected.score.benchmarkSum && Number(f.count) === expected.score.count && bytes(f.question_digest) === expected.questionDigest && bytes(f.resolution_digest) === expected.resolutionDigest && bytes(f.agent_id) === Buffer.from(expected.agentId, 'utf8').toString('hex') && bytes(f.model_hash) === sha256(expected.modelVersion);
      return { status: linked ? 'verified' : 'mismatch', objectId };
    } catch { return { status: 'unavailable', objectId }; }
  }
}
