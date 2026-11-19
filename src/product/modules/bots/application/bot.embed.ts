import { env } from '../../../../config/env.js';

/** The copy-paste snippet shown in the admin settings page. */
export const embedSnippet = (slug: string): string => {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return [
    `<!-- AI admissions assistant: calls ${base}/public/${slug}/bot/config and /message -->`,
    `<div id="cp-bot"></div>`,
    `<script>`,
    `(function(){var B='${base}/public/${slug}/bot',t=localStorage.getItem('cpBotToken'),el=document.getElementById('cp-bot');`,
    `fetch(B+'/config').then(function(r){return r.json()}).then(function(c){el.innerHTML='<p>'+c.greeting.replace(/</g,'&lt;')+'</p><small>'+c.consentText.replace(/</g,'&lt;')+'</small><br><input id="cpm" maxlength="1000"><button id="cps">Send</button><div id="cpo"></div>';`,
    `document.getElementById('cps').onclick=function(){var i=document.getElementById('cpm'),m=i.value;if(!m)return;i.value='';`,
    `fetch(B+'/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:m,visitorToken:t||undefined,consent:true})}).then(function(r){return r.json()}).then(function(d){if(d.visitorToken){t=d.visitorToken;localStorage.setItem('cpBotToken',t)}`,
    `var o=document.getElementById('cpo'),p=document.createElement('p');p.textContent=(d.reply||(d.error&&d.error.message)||'');o.appendChild(p)})}})})();`,
    `</script>`,
  ].join('\n');
};
