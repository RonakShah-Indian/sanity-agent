'use strict';

/** Shared CSS — kept here so every dashboard view inlines the same styles. */
const CSS = `
* { box-sizing: border-box; }
body { margin:0; background:#0f172a; color:#e2e8f0;
  font-family:-apple-system,Segoe UI,Roboto,sans-serif; min-height:100vh; }
a { color:#7dd3fc; text-decoration:none; }
a:hover { text-decoration:underline; }
header { padding:14px 28px; background:#020617; border-bottom:1px solid #1e293b;
  display:flex; gap:24px; align-items:center; }
header h1 { font-size:16px; margin:0; font-weight:700; letter-spacing:.04em; }
header nav { display:flex; gap:18px; font-size:13px; }
header nav a { color:#94a3b8; }
header nav a.active { color:#e2e8f0; font-weight:600; }
main { padding:28px; max-width:1400px; margin:0 auto; }
h2 { margin:0 0 16px; font-size:20px; }
.muted { color:#94a3b8; font-size:13px; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:14px; margin-bottom:24px; }
.card { background:#1e293b; border:1px solid #334155; border-radius:12px; padding:16px 20px; }
.card .n { font-size:28px; font-weight:700; }
.card .l { color:#94a3b8; font-size:12px; text-transform:uppercase; letter-spacing:.04em; margin-top:4px; }
table { width:100%; border-collapse:collapse; background:#1e293b;
  border-radius:12px; overflow:hidden; margin-bottom:24px; }
th, td { text-align:left; padding:12px 14px; border-bottom:1px solid #334155;
  font-size:13px; vertical-align:top; }
th { background:#0f172a; color:#94a3b8; text-transform:uppercase;
  font-size:11px; letter-spacing:.04em; }
tr:hover td { background:#172033; }
.status { font-weight:600; text-transform:uppercase; font-size:11px;
  padding:2px 8px; border-radius:99px; }
.s-passed { background:#16a34a22; color:#86efac; border:1px solid #16a34a77; }
.s-degraded { background:#d9770622; color:#fcd34d; border:1px solid #d9770677; }
.s-failed { background:#dc262622; color:#fca5a5; border:1px solid #dc262677; }
.s-critical { background:#991b1b22; color:#fecaca; border:1px solid #991b1b77; }
.s-healthy { background:#16a34a22; color:#86efac; border:1px solid #16a34a77; }
.s-unhealthy { background:#dc262622; color:#fca5a5; border:1px solid #dc262677; }
.bd-h { font-size:11px; text-transform:uppercase; color:#94a3b8;
  letter-spacing:.06em; margin-bottom:8px; }
.panel { background:#1e293b; border:1px solid #334155; border-radius:12px;
  padding:18px 22px; margin-bottom:18px; }
.row { display:flex; justify-content:space-between; padding:6px 0;
  border-bottom:1px solid #1e293b; font-size:13px; }
.row:last-child { border-bottom:none; }
input[type="search"], select { background:#0f172a; color:#e2e8f0;
  border:1px solid #334155; border-radius:6px; padding:6px 10px; font-size:13px; }
.pill { display:inline-block; padding:2px 8px; border-radius:99px;
  font-size:11px; margin:2px 2px; }
.kbd { font-family:Menlo,monospace; background:#0b1220; padding:1px 6px;
  border-radius:4px; color:#7dd3fc; font-size:12px; }
`;

module.exports = { CSS };
