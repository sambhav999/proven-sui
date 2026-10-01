import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { seedDemo } from '../server/demo.js';
import { createApp } from '../server/app.js';

test('illustrative records are explicitly marked and fail real verification', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proven-demo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  await store.mutate(seedDemo);
  const app = createApp({ store, chain: { enabled: false, verifyObject: async () => ({status:'not_anchored'}) }, env: { DEMO_MODE:'true' } });
  const server = app.listen(0,'127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exams = await (await fetch(base+'/api/exams')).json();
  assert.equal(exams.length,1);
  assert.equal(exams[0].demo,true);
  const receipt = store.state.receipts[0];
  const check = await (await fetch(base+'/api/verify/'+receipt.id)).json();
  assert.equal(check.demo,true);
  assert.equal(check.signatureValid,false);
  assert.equal(check.chain.status,'not_anchored');
});
