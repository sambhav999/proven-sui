import process from 'node:process';
import express from 'express';
import { openStore } from '../server/store.js';
import { SuiAnchor } from '../server/sui.js';
import { seedDemo } from '../server/demo.js';
import { createApp } from '../server/app.js';

// Values pasted into Vercel from a .env file can keep their surrounding quotes.
const unquote = (value) => value?.replace(/^(['"])(.*)\1$/, '$2');

async function start() {
  const env = { ...process.env, MONGODB_URI: unquote(process.env.MONGODB_URI), DATA_DIR: process.env.DATA_DIR || '/tmp/proven-data' };
  // Without MONGODB_URI this falls back to /tmp, which Vercel wipes on cold starts.
  const store = await openStore(env);
  if (env.DEMO_MODE === 'true' && store.state.exams.length === 0) {
    await store.mutate(seedDemo);
  }
  const app = express();
  // Other instances may have written since this one last read, so reload before each request.
  if (store.load) app.use((_req, _res, next) => store.load().then(() => next(), next));
  app.use(createApp({ store, chain: new SuiAnchor(env), env }));
  return app;
}

let ready = null;
export default async function handler(req, res) {
  ready ||= start().catch(error => { ready = null; throw error; });
  try {
    (await ready)(req, res);
  } catch (error) {
    console.error('Startup failed', error);
    const reason = String(error?.message || error).replace(/mongodb(\+srv)?:\/\/\S+/g, '<MONGODB_URI>');
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Server failed to start: ${reason}` }));
  }
}
