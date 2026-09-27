// Analysis worker for the experimental tw8 page (2026-09-27): a second copy of the engine searches the current position
// while the human thinks, one deepening iteration per timeslice, and reports after every depth. A newer position
// replaces the current one between iterations; nothing is ever played.
importScripts('../hn8.js'+self.location.search);
let M=null,want=null,started=null;
HN().then(m=>{ M=m; tick(); });
self.onmessage=e=>{ want = e.data.type==='stop' ? null : e.data; };
function report(done){
  const pv=[]; for(let k=0;k<M._hn_pv_len();k++) pv.push(M._hn_pv(k));
  self.postMessage({type:'report',gen:started.gen,stm:M._hn_stm(),depth:M._hn_last(0),nodes:M._hn_last(1),ms:M._hn_last(2),score:M._hn_last(3)/100,nps:M._hn_last(4),pv,done});
}
function tick(){
  if(M){
    if(want && (!started || started.gen!==want.gen)){   // a new position: set it up and begin
      started=want; M._hn_init(started.red,started.white);
      for(const h of started.moves){ if(h>=0) M._hn_play(h); else M._hn_pass(); }
      if(!M._hn_think_begin(started.nodes)){ self.postMessage({type:'report',gen:started.gen,stm:M._hn_stm(),depth:0,nodes:0,ms:0,score:0,nps:0,pv:[],done:true,nomove:true}); started.finished=true; }
      else { started.finished=false; report(false); }
    } else if(started && !started.finished && want && want.gen===started.gen){
      const more=M._hn_think_step(); report(!more); if(!more) started.finished=true;
    }
  }
  setTimeout(tick, started && !started.finished && want ? 0 : 50);
}
