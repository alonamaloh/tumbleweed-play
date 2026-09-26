// Search worker for the tw8 page: keeps its own engine copy in step with the page (init/play/pass) and runs the searches.
// 'think' searches and plays (one reply); 'analyse' runs the budgets one by one and posts a result after each; a position
// change or 'stop' drops the remaining budgets.
"use strict";
let M=null, queue=[], busy=false, gen=0;
importScripts('hn8.js?v=' + (self.location.search.split('v=')[1] || 'x'));
HN().then(m=>{ M=m; postMessage({type:'ready'}); pump(); }).catch(err=>postMessage({type:'error', message:'engine load: '+String(err&&err.message||err)}));
function report(){ const L=M._hn_pv_len(), pv=[]; for(let k=0;k<L;k++)pv.push(M._hn_pv(k));
  return {depth:M._hn_last(0), nodes:M._hn_last(1), ms:M._hn_last(2), score:M._hn_last(3)/100, nps:M._hn_last(4), pv}; }
onmessage=e=>{ const msg=e.data;
  if(msg.type==='stop'){ gen++; queue=queue.filter(q=>q.type!=='analyse'); return; }
  if(msg.type!=='analyse'&&msg.type!=='think') gen++;          // a position change drops pending analysis budgets
  queue.push({...msg, gen}); pump(); };
function pump(){
  if(!M||busy||!queue.length)return; const msg=queue.shift(); busy=true;
  try{
    if(msg.type==='init') M._hn_init(msg.red,msg.white);
    else if(msg.type==='play') M._hn_play(msg.cell);
    else if(msg.type==='pass') M._hn_pass();
    else if(msg.type==='think'){ const mv=M._hn_think_nodes(msg.nodes); postMessage({type:'move', id:msg.id, move:mv, report:report()}); }
    else if(msg.type==='analyse' && msg.gen===gen && msg.budgets.length){
      const nodes=msg.budgets[0], rest=msg.budgets.slice(1);
      const mv=M._hn_analyse(nodes); const r=report(); r.move=mv; r.budget=nodes;
      postMessage({type:'analysis', id:msg.id, done:rest.length===0, ...r});
      if(rest.length) queue.unshift({...msg, budgets:rest});   // next budget after any queued position updates
    }
  } catch(err){ postMessage({type:'error', message:String(err&&err.message||err)}); }
  finally { busy=false; if(queue.length) setTimeout(pump,0); }
}
