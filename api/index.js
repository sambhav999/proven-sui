import process from 'node:process';
import express from 'express';
import { openStore } from '../server/store.js';
import { SuiAnchor } from '../server/sui.js';
import { seedDemo } from '../server/demo.js';
import { createApp } from '../server/app.js';

// Without MONGODB_URI this falls back to /tmp, which Vercel wipes on cold starts.
const store = await openStore({ ...process.env, DATA_DIR: process.env.DATA_DIR || '/tmp/proven-data' });
if (process.env.DEMO_MODE === 'true' && store.state.exams.length === 0) {
  await store.mutate(seedDemo);
}

const app = express();
// Other instances may have written since this one last read, so reload before each request.
if (store.load) app.use((_req, _res, next) => store.load().then(() => next(), next));
app.use(createApp({ store, chain: new SuiAnchor() }));
export default app;
