import { randomBytes } from 'node:crypto';

/**
 * Small, user-facing PolyU sign-in window. Keep this page deliberately free of
 * implementation terms: the separate school sign-in window handles the actual
 * credentials, while this page only starts the connection and reports status.
 */
export function authorizationHTML() {
  const nonce = randomBytes(18).toString('base64');
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><title>连接 PolyU</title><style>
*{box-sizing:border-box}body{margin:0;background:#fff;color:#000;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(420px,100%);margin:0 auto;padding:48px 28px}header{margin-bottom:34px}.mark{font-size:13px;font-weight:700;letter-spacing:.18em;margin-bottom:26px}h1{font-size:30px;line-height:1.15;letter-spacing:-.04em;margin:0 0 14px}p{line-height:1.6;margin:0}.card{border:1px solid #000;padding:22px;margin-top:28px}label{display:block;font-size:13px;font-weight:600;margin-bottom:8px}select,button{font:inherit;width:100%;height:44px;border:1px solid #000;border-radius:0;background:#fff;color:#000;padding:0 12px}button{background:#000;color:#fff;font-weight:600;cursor:pointer;margin-top:16px}button:disabled{background:#fff;color:#000;cursor:wait}.status{border-top:1px solid #000;margin-top:18px;padding-top:14px;min-height:42px}.hint{font-size:12px;margin-top:24px}</style></head><body><main><header><div class="mark">POLYU</div><h1>连接 PolyU</h1><p>登录后，Codex 可以帮你查看 Canvas 和 Blackboard 的课程、通知、作业与安排。</p></header><section class="card"><label for="platform">登录平台</label><select id="platform"><option value="all">Canvas 和 Blackboard</option><option value="canvas">Canvas</option><option value="blackboard">Blackboard</option></select><button id="login">开始登录</button><p id="status" class="status" role="status">准备就绪</p></section><p class="hint">登录完成后，返回 Codex 继续提问即可。</p></main><script nonce="${nonce}">
const platform=document.getElementById('platform'),status=document.getElementById('status'),login=document.getElementById('login');
function render(s){const ready=s.profiles.some(p=>p.id==='polyu');status.textContent=ready?(s.message||'准备就绪'):'请先在 Codex 中连接 PolyU';login.disabled=!!s.busy||!ready;}
window.lms.onState(render);window.lms.state().then(render);
login.onclick=async()=>{try{status.textContent='正在打开登录页面…';login.disabled=true;await window.lms.login('polyu',platform.value)}catch{status.textContent='无法开始登录，请重试。';login.disabled=false}};
</script></body></html>`;
}
