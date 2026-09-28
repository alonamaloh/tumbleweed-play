// Search worker of the experimental tw8 page (2026-09-27). Every search of the page runs here, the engine's own move
// and the analysis alike, so the page never blocks. The engine calls hnRootMove before each root move and hnRootBest
// on each new best move, and the worker passes them on; nodes, time and speed come once, with the final message.
// Nothing is played here: the page plays the move it is told. The board follows the page's move list, so the
// transposition table survives from move to move as long as the game just continues.
importScripts('../hn8.js'+self.location.search);
let M=null, job=null, queued=null, cur=null;
const pv=()=>{ const a=[]; for(let k=0;k<M._hn_pv_len();k++) a.push(M._hn_pv(k)); return a; };
const edge=x=>Math.abs(x)>=(1<<20)?(x<0?-Infinity:Infinity):x/256;   // an aspiration window edge in cells
self.hnRootMove=(depth,index,count,move,lo,hi)=>self.postMessage({type:'move',gen:job.gen,depth,index,count,move,lo:edge(lo),hi:edge(hi)});
let lastBest=null;   // the last best-move report of the running search: depth and what its score is (0 exact, 1 at least, 2 at most)
self.hnRootBest=(depth,move,bound)=>{ lastBest={depth,bound}; self.postMessage({type:'best',gen:job.gen,depth,bound,score:M._hn_last(3)/100,pv:pv()}); };
function setPosition(j){
  const same=cur && cur.red===j.red && cur.white===j.white && cur.moves.length<=j.moves.length && cur.moves.every((h,k)=>h===j.moves[k]);
  if(!same){ M._hn_init(j.red,j.white); cur={red:j.red,white:j.white,moves:[]}; }
  for(let k=cur.moves.length;k<j.moves.length;k++){ const h=j.moves[k]; if(h>=0) M._hn_play(h); else M._hn_pass(); cur.moves.push(h); }
}
function run(){
  if(!M||!queued) return;
  job=queued; queued=null; lastBest=null; setPosition(job);
  if(!M._hn_think_begin(job.nodes)){ self.postMessage({type:'done',gen:job.gen,bound:0,best:-1,depth:0,nodes:0,ms:0,nps:0,score:0,pv:[]}); return; }
  while(M._hn_think_step()){}
  const line=pv(), depth=M._hn_last(0);
  const bound=(lastBest && lastBest.depth>depth) ? lastBest.bound : 0;   // the score of an unfinished depth keeps its mark
  self.postMessage({type:'done',gen:job.gen,bound,best:line.length?line[0]:-1,depth,nodes:M._hn_last(1),ms:M._hn_last(2),nps:M._hn_last(4),score:M._hn_last(3)/100,pv:line});
}
self.onmessage=e=>{ if(e.data.type==='search'){ queued=e.data; run(); } };
HN().then(m=>{ M=m; run(); });
