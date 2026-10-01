import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const freshState = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { version: 1, agents: [], exams: [], entries: [], receipts: [], issuerPrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), issuerPublicKey: publicKey.export({ format: 'pem', type: 'spki' }) };
};

export class Store {
  constructor(dataDir) { this.file = path.resolve(dataDir, 'state.json'); this.queue = Promise.resolve(); this.state = null; }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = freshState();
      await this.save();
    }
    return this;
  }

  async save() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }

  // A single-process deployment serializes writes, including RPC await points.
  async mutate(fn) {
    const next = this.queue.then(async () => { const result = await fn(this.state); await this.save(); return result; });
    this.queue = next.catch(() => {});
    return next;
  }
}

const LOCK_LEASE_MS = 60_000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Keeps the whole state in one document so every instance (e.g. each Vercel function)
// shares it. A lease lock in the same collection serializes writes across instances,
// so mutate() keeps the file store's semantics, including chain RPCs inside fn.
export class MongoStore {
  constructor(uri, { dbName = 'proven', collection = 'sui' } = {}) {
    this.client = new MongoClient(uri);
    this.dbName = dbName; this.collectionName = collection;
    this.queue = Promise.resolve(); this.state = null;
  }

  async init() {
    await this.client.connect();
    this.col = this.client.db(this.dbName).collection(this.collectionName);
    try { await this.col.insertOne({ _id: 'state', ...freshState() }); }
    catch (error) { if (error.code !== 11000) throw error; }
    await this.load();
    return this;
  }

  async load() {
    const { _id, ...state } = await this.col.findOne({ _id: 'state' });
    this.state = state;
    return this.state;
  }

  async save() { await this.col.replaceOne({ _id: 'state' }, this.state); }

  async lock() {
    const owner = randomUUID();
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      try {
        await this.col.updateOne({ _id: 'lock', until: { $lt: now } }, { $set: { owner, until: now + LOCK_LEASE_MS } }, { upsert: true });
        return owner;
      } catch (error) {
        if (error.code !== 11000) throw error;
        if (attempt > 300) throw new Error('Timed out waiting for the state lock');
        await sleep(100 + Math.random() * 100);
      }
    }
  }

  async unlock(owner) { await this.col.updateOne({ _id: 'lock', owner }, { $set: { until: 0 } }); }

  async mutate(fn) {
    const next = this.queue.then(async () => {
      const owner = await this.lock();
      try { await this.load(); const result = await fn(this.state); await this.save(); return result; }
      finally { await this.unlock(owner); }
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

export const openStore = (env = process.env) => (env.MONGODB_URI
  ? new MongoStore(env.MONGODB_URI, { dbName: env.MONGODB_DB || 'proven' })
  : new Store(env.DATA_DIR || './data')).init();
