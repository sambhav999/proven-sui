import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

export class Store {
  constructor(dataDir) { this.file = path.resolve(dataDir, 'state.json'); this.queue = Promise.resolve(); this.state = null; }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      this.state = { version: 1, agents: [], exams: [], entries: [], receipts: [], issuerPrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), issuerPublicKey: publicKey.export({ format: 'pem', type: 'spki' }) };
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
