# P0/P1/P2 delivery status (2026-08-22)

## Done (code + verification)
- tsc zero errors (fixed 9 MediaKind audio propagation sites + 1 TTS route issue)
- Production build passes: all new routes in output (batches x3 / skus x3 / character-cards / tts x2)
- commit 0264163 pushed to origin/image (safe on GitHub)

## Deployment blocked (needs owner)
- vercel CLI unavailable: no node_modules entry, ~/.cache readonly blocks npx, no auth.json
- Built recursive tarball installer, vercel 59.3.0 works at .tools/vstore/ but no auth token
- Vercel project has no git integration (repo is old personal_site history; pushing image does not deploy)
- OWNER ACTION: vercel login or set VERCEL_TOKEN, then run:
  node .tools/vstore/node_modules/vercel/dist/index.js --prod --yes

## Module status
- Batch API: code complete (batch-service 689 lines + tests + 3 routes); VPS schema not migrated (stateless fallback pending verify)
- SKU engine: code complete (expand/run-service + tests + 3 routes + docs/biz-api.md section)
- Character cards: mostly complete (cards + store + tests + collection route); [id] subroute missing
- TTS: core kind wired in 4 files + 2 routes (orchestrator-added); upstream adapter not connected (no key)
- Canvas semantic nodes: complete (subagent delivered, deployed previously)
## Deploy breakthrough (2026-08-22 late night)
- vercel 59.3.0 has a bug (config read crash 'reading date'); 42.0.0 auth works but API requires >=47.2.2; **48.12.1 = working version**
- Recursive tarball installer: .tools/install-vercel42.cjs <version> -> .tools/vstore42/
- **Deployed Ready: https://imagegen-one-puce.vercel.app** (ujkanicina-1748/image_gen)
- All new routes verified: skus 200 / batches 405 / character-cards 401 / tts 405 / healthz 200
- NOTE: www.eimu.dev is owned by main account (team_tOdYoQMCy690bxXnXJZErAgm) project; ujkanicina has no access. Owner needs to run from main account:
  cd /home/lenovo/Desktop/image-app && node .tools/vstore42/node_modules/vercel/dist/index.js --prod --yes
- If .vercel is old format (project.json with settings), backup then delete and re-link (vercel link --yes --project=image_gen)
