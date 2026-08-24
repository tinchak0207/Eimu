process.on('uncaughtException', e => { console.error('UNCAUGHT:', e.stack); process.exit(1); });
process.on('unhandledRejection', e => { console.error('REJECTION:', e && e.stack || e); process.exit(1); });
await import('./vstore/node_modules/vercel/dist/index.js');