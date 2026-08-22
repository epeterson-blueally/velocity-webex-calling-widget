import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const bundle = readFileSync('./dist/velocity-webex-calling.js','utf8');
const dom = new JSDOM(`<!DOCTYPE html><body>
  <velocity-webex-calling id="w" client-id="C123" redirect-uri="https://x.io/oauth-callback.html" auth-base-url="https://api.workers.dev" agent-id="agent-1" org-id="org-1" dark-mode="true"></velocity-webex-calling>
</body>`, { runScripts:'outside-only', url:'https://x.io/', pretendToBeVisual:true });
const { window } = dom;
window.fetch = () => Promise.resolve({ ok:false, status:400, json:()=>Promise.resolve({}) }); // stub
window.matchMedia = window.matchMedia || (() => ({matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}}));
let threw=null; try { window.eval(bundle); } catch(e){ threw=e; }
const el = window.document.getElementById('w');
const sr = el && el.shadowRoot;
const txt = sr ? sr.textContent.replace(/\s+/g,' ').trim() : '(none)';
console.log('eval threw?        :', threw ? threw.message : 'no');
console.log('shows sign-in gate?:', /sign in/i.test(txt));
console.log('rendered text      :', txt.replace(/:host[^}]*}[^A-Za-z]*/,'').replace(/\.[a-z-]+\s*{[^}]*}/g,'').slice(0,400));
