import process from 'node:process';
import { openStore } from './store.js';
import { SuiAnchor } from './sui.js';
import { seedDemo } from './demo.js';
import { createApp } from './app.js';

try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const store = await openStore();
if (process.env.DEMO_MODE === 'true' && store.state.exams.length === 0) {
  await store.mutate(seedDemo);
}
const chain = new SuiAnchor();
const port = Number(process.env.PORT || 3000);
createApp({ store, chain }).listen(port, '0.0.0.0', () => {
  console.log(`PROVEN listening on ${port} (${chain.enabled ? `${chain.network} anchoring` : 'local receipts'})`);
});
