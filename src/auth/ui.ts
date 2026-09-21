import { randomBytes } from 'node:crypto';
import { platformDefinitions } from '../platforms/registry.js';

/** School names and origins are rendered as text, never HTML or script source. */
export function authorizationHTML() {
  const nonce = randomBytes(18).toString('base64');
  const definitions = JSON.stringify(platformDefinitions.map(({ id, label }) => ({ id, label }))).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><title>lms-cli</title><style>
*{box-sizing:border-box}body{margin:0;background:#fff;color:#000;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(460px,100%);margin:0 auto;padding:36px 28px}header{margin-bottom:26px}h1{font-size:32px;line-height:1.15;letter-spacing:-.04em;margin:0 0 14px}p{line-height:1.6;margin:0}.card{border:1px solid #000;padding:22px;margin-top:24px}label{display:block;font-size:13px;font-weight:600;margin:16px 0 8px}label:first-child{margin-top:0}select,button{font:inherit;width:100%;height:44px;border:1px solid #000;border-radius:0;background:#fff;color:#000;padding:0 12px}button{background:#000;color:#fff;font-weight:600;cursor:pointer;margin-top:16px}button:disabled{background:#fff;color:#000;cursor:default}.status{border-top:1px solid #000;margin-top:18px;padding-top:14px;min-height:42px}.hint{font-size:12px;margin-top:20px}.origins{font-size:12px;overflow-wrap:anywhere;white-space:pre-line;margin-top:10px}code{font-size:12px}</style></head><body><main><header><h1>lms-cli</h1><p>支持多学校的 Canvas / Blackboard CLI 与 Agent 工具</p></header><section class="card"><label for="school">学校 / 账号</label><select id="school" aria-label="学校 / 账号"></select><label for="platform">登录平台</label><select id="platform"></select><p id="origins" class="origins"></p><button id="login" disabled>开始登录</button><p id="status" class="status" role="status" aria-live="polite">正在读取学校配置…</p></section><p class="hint">请先核对学校网址，再在弹出的学校页面中完成登录。是否可用取决于学校登录政策及平台版本。</p><p id="setup" class="hint" hidden>请在终端运行 <code>lms setup</code> 添加学校。已有配置可运行 <code>lms profiles list</code> 查看。</p></main><script nonce="${nonce}">
const school=document.getElementById('school'),platform=document.getElementById('platform'),origins=document.getElementById('origins'),status=document.getElementById('status'),login=document.getElementById('login'),setup=document.getElementById('setup');
const definitions=${definitions};
let latest={profiles:[],busy:false};
function option(value,label){const node=document.createElement('option');node.value=value;node.textContent=label;return node;}
function render(s){
  latest=s;
  const selected=s.lockedProfile||(s.profiles.some(p=>p.id===school.value)?school.value:s.active)||s.profiles[0]?.id||'';
  school.replaceChildren(...s.profiles.map(p=>option(p.id,p.label+' ('+p.id+')')));school.value=selected;
  const p=s.profiles.find(p=>p.id===school.value),available=p?definitions.filter(d=>p[d.id]).map(d=>d.id):[];
  const label=k=>definitions.find(d=>d.id===k).label;
  const previous=platform.value;
  platform.replaceChildren(...(available.length>1?[option('all','所有已配置平台')]:[]),...available.map(k=>option(k,label(k))));
  platform.value=available.includes(previous)?previous:(available.length>1?'all':available[0]||'');
  origins.textContent=p?available.map(k=>label(k)+': '+p[k]).join('\\n'):'';
  school.disabled=!!s.busy||!!s.lockedProfile||!p;platform.disabled=!!s.busy||!p;
  login.disabled=!!s.busy||!p;setup.hidden=!!p;
  status.textContent=p?(s.message||'准备就绪'):'请先添加学校 / 账号配置';
}
school.onchange=()=>{platform.value='';render({...latest,message:'准备就绪'});};
window.lms.onState(render);window.lms.state().then(render).catch(()=>{status.textContent='无法读取学校配置，请返回终端检查。';setup.hidden=false;});
login.onclick=async()=>{try{render({...latest,busy:true,message:'正在打开学校登录页面…'});await window.lms.login(school.value,platform.value)}catch{render({...latest,busy:false,message:'无法开始登录，请重试。'})}};
</script></body></html>`;
}
