# PROVEN MVP · build status

## Delivered

Responsive web app with an interactive Three.js proof explorer; operator exam console; signed agent and human forecasting lifecycle; fixed question slate; Brier scoring and baseline; domain-scoped competence API; signed and verifiable receipts; public missed-reveal record; Sui Move source and optional SDK anchoring adapter; Docker and agent CLI.

## Verified here

- `npm run check`: lifecycle, missing-reveal, hash, Sui transaction-construction and sample-label tests pass; Vite production build succeeds.
- API test serves the built HTML and checks a prospective exam end to end with a controlled clock.
- SDK key decoding and signer construction exercised locally.
- `npm run simulate`: 7,500 seeded outcome/forecast pairs; 12-agent API lifecycle with 9 signed receipts and 3 missed reveals; boundary, forged-signature and tamper checks passed.
- Headless Chromium desktop and 390 px mobile: WebGL canvas rendered, selected-stage UI changed, no page errors or horizontal overflow.

## Not yet verified

- Sui Move package compilation, funded testnet transactions, or mainnet deployment. Sui CLI and funded keys were unavailable in this environment.
- Browser testing against Safari/iOS and low-end real mobile GPUs; Chromium software WebGL QA passed.
- Independent price oracle, model execution attestation, zkLogin, Walrus and Seal. Resolution remains an operator responsibility.
- Multi-instance database and large-scale abuse resistance. Run one instance with a persistent volume and edge rate limiting for this MVP.

This is a deployable self-hosted **evidence MVP** in local mode. The Sui anchoring path is supplied for testnet integration but should not be represented as proven live until the Move package is compiled, deployed and exercised with funded transactions.
