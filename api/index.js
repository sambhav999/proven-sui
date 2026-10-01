import process from 'node:process';
import { Store } from '../server/store.js';
import { SuiAnchor } from '../server/sui.js';
import { seedDemo } from '../server/demo.js';
import { createApp } from '../server/app.js';

// Vercel's filesystem is read-only outside /tmp, and /tmp is wiped on cold starts,
// so state (including the issuer key) only lives as long as the function instance.
const store = await new Store(process.env.DATA_DIR || '/tmp/proven-data').init();
if (process.env.DEMO_MODE === 'true' && store.state.exams.length === 0) {
  await store.mutate(seedDemo);
}

export default createApp({ store, chain: new SuiAnchor() });
