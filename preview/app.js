"use strict";
const $=id=>document.getElementById(id), P=Position;
const names={human:"Human imitation",jesse:"JesseJames",highnoon:"HighNoon"};
const avatars={human:"unknown",jesse:"jessejames",highnoon:"highnoon"};
const opponents=["human","jesse","highnoon"];
const MIN_THINKING_MS=1200;
const defaults={opponent:"human",profile:"elo:1500",side:8,opening:0,humanity:.8,tumbstoneSims:256,jesseSims:256,sound:true,customEngine:2,customTurn:1};
let prefs={...defaults};
try {Object.assign(prefs,JSON.parse(localStorage.getItem("highnoon-settings-v2")||"{}"));}catch{}
if(!opponents.includes(prefs.opponent))prefs.opponent=defaults.opponent;
if(![6,8].includes(prefs.side))prefs.side=8;
if(prefs.opponent!=="highnoon")prefs.side=8;
prefs.opening=0; // Arbitrary positions live in Analyze's editor.
for(const k of ["customEngine","customTurn"])if(![1,2].includes(prefs[k]))prefs[k]=defaults[k];
if(!Number.isFinite(prefs.humanity)||prefs.humanity<0||prefs.humanity>1)prefs.humanity=.8;
if(!Number.isInteger(prefs.tumbstoneSims)||prefs.tumbstoneSims<1||prefs.tumbstoneSims>100000)prefs.tumbstoneSims=256;
prefs.jesseSims=256;
const url=new URL(location.href);
if(prefs.opponent==="highnoon"&&[6,8].includes(Number(url.searchParams.get("size"))))prefs.side=Number(url.searchParams.get("size"));
let side=prefs.side,opponent=prefs.opponent,board=null,initial=P.blank(side),moves=[],cursor=0;
let mode="setup",stage="placing",placements=[],handicap=prefs.opening,humanSide=0;
let worker=null,workerKind=null,workerReady=false,workerPromise=null,workerResolve=null;
let searchedPosition=null;
let generation=0,task=null,result=null,editingBackup=null,editUndo=[],hover=null,loadingBoard=false;
let progress={visits:0,target:0,inherited:0};
let boardToken=0,focusedCell=null,marginHistory=new Map(),audio=null;
let boardView="ownership",engineBackend=null,measuredSpeed=null,gameAnalysis=null,gameAnalysisTimer=null,analysisMessage="";
let gpuHalfPrecision=null,lastInference=null,scanImplementation="sequential";
const analysisRecords=new Map(),analysisCache=new Map();
// Display maps survive a search restart without becoming completed analysis.
// Key by the actual position, including turn and size, rather than move number.
const ownershipMaps=new Map();
let ownershipRequest=null;
let humanProfiles=[],setupRequest=null,savedPlay=null,challenge=null,welcomeOpen=true,humanAvailable=true,pinnedCandidate=null;
let browserHuman=null;
let playChoice=null;
let challengeProgress={handicap:6,wins:0,losses:0,completed:[]};
try {Object.assign(challengeProgress,JSON.parse(localStorage.getItem("highnoon-challenge-v1")||"{}"));}catch{}
if(!Number.isInteger(challengeProgress.handicap)||challengeProgress.handicap<1||challengeProgress.handicap>167)challengeProgress.handicap=6;
if(!Array.isArray(challengeProgress.completed))challengeProgress.completed=[];
let playFinished=null;
// Explain move: the game review's commentary (review-*.js) on the move played from a position, at a fixed
// effort so that the text does not depend on the effort chosen for analysis. Both moves are searched alike with
// `visits`. The native bridge supplies its deeper review settings; this webpage uses 24 simulations for threats.
const REVIEW=Object.freeze({visits:600,threatVisits:24,...globalThis.highNoonReviewSettings}),reviewCalls=new Map(),explanations=new Map();
let reviewSerial=0,explaining=null,gameReview=null;
// The whole review of the game (review-view.js draws it): a saved one that was loaded, or the one made here.
let sideTab="move",shownReview=null,shownParts=null,shownSerial=0,reviewRun=null;   // shownParts: the parts a review being made has so far (null: whole)
const reviewAnswers=new Map();   // the engine's answers to a whole review, kept so that a stopped review goes on where it was
// The record counts the two starting stacks as moves 1 and 2, and so does every sentence of a review.
const numberOffset=()=>initial?.kind==="normal"?2:0;
let linePreview=null;   // {index,line,k}: the engine's line being played out on the board for the explained move
const savePrefs=()=>{try{localStorage.setItem("highnoon-settings-v2",JSON.stringify(prefs));}catch{}};
const signed=v=>Number.isFinite(v)?(v>0?"+":"")+v.toFixed(1):"—";
const fail=e=>{$("error").textContent=e instanceof Error?e.message:String(e);};
const clearError=()=>{$("error").textContent="";};
const cname=c=>P.cellName(side,c);
const currentEngine=()=>mode==="analysis"?"highnoon":opponent;
const effort=kind=>kind==="human"?1:kind==="jesse"?256:prefs.tumbstoneSims;
const humanProfile=()=>humanProfiles.find(p=>p.key===prefs.profile);
const opponentName=()=>opponent==="human"?humanProfile()?.name||"Human imitation":names[opponent];

async function waitForThinking(startedAt){
  const remaining=MIN_THINKING_MS-(performance.now()-startedAt);
  if(remaining>0)await new Promise(resolve=>setTimeout(resolve,Math.ceil(remaining)));
}

function stopGameAnalysis(){
  if(gameAnalysis)analysisMessage=`Analysis stopped · ${gameAnalysis.done} of ${gameAnalysis.end+1} positions`;
  gameAnalysis=null;if(gameAnalysisTimer!==null)clearTimeout(gameAnalysisTimer);gameAnalysisTimer=null;
}
function stopReview(){
  explaining=null;reviewRun=null;
  for(const call of reviewCalls.values())call.reject(new Error("stopped"));
  reviewCalls.clear();
}
function cancelSearch(keepGameAnalysis=false){
  if(!keepGameAnalysis)stopGameAnalysis();
  pinnedCandidate=null;hover=null;
  const busy=!!task||!!explaining||reviewCalls.size>0;
  if(setupRequest&&mode==="setup"&&stage==="offering")stage="placing";
  stopReview();generation++;task=null;setupRequest?.abort();setupRequest=null;
  if(workerKind==="highnoon"&&busy)disposeWorker();else if(worker)worker.postMessage({type:"stop"});
  $("stop").disabled=true;
}
function clearAnalysis(){marginHistory.clear();analysisRecords.clear();analysisCache.clear();ownershipMaps.clear();ownershipRequest=null;explanations.clear();gameReview=null;shownReview=null;analysisMessage="";}
function ownershipKey(){return JSON.stringify([side,board._hn_stm(),currentCodes()]);}
function rememberOwnership(ownership){
  if(!ownership||ownership.length!==P.grid(side)**2)return;
  const key=ownershipKey();ownershipMaps.delete(key);ownershipMaps.set(key,Float32Array.from(ownership));
  while(ownershipMaps.size>256)ownershipMaps.delete(ownershipMaps.keys().next().value);
}
function trimAnalysis(after){
  gameReview=null;shownReview=null;   // the game changed: a review of the old one no longer applies
  for(const map of [marginHistory,analysisRecords,analysisCache])for(const key of map.keys())if(key>=after)map.delete(key);
  for(const key of explanations.keys())if(key>=after-1)explanations.delete(key);   // an explanation is about the move played from its position
}
function analysisSnapshot(data){
  // Retain reports for the whole current game, never search trees. Compact
  // cell maps keep review history small; scores and visit counts stay doubles.
  return {...data,
    ownership:Float32Array.from(data.ownership),
    stdev:data.stdev?Float32Array.from(data.stdev):undefined,
    rootOwnership:data.rootOwnership?Float32Array.from(data.rootOwnership):undefined,
    candidates:data.candidates.map(c=>({...c,ownership:Float32Array.from(c.ownership)})),
  };
}
function rememberAnalysis(data,request){
  if(request.purpose!=="analysis"||!Number.isFinite(data.redMargin))return;
  const complete=data.type==="done"&&data.engineComplete&&!data.stopped;
  marginHistory.set(request.index,data.redMargin);
  analysisRecords.set(request.index,{complete,target:request.target,exact:data.engineStatus==="terminal"});
  if(complete)analysisCache.set(request.index,analysisSnapshot(data));
}
function analysisSatisfied(index,target){const r=analysisRecords.get(index);return r?.complete&&(r.exact||(target===1?r.target===1:r.target>=target));}
function queueGameAnalysis(){
  if(!gameAnalysis||gameAnalysisTimer!==null)return;
  const run=gameAnalysis;
  gameAnalysisTimer=setTimeout(()=>{
    gameAnalysisTimer=null;if(gameAnalysis!==run||mode!=="analysis")return;
    while(run.next<=run.end&&analysisSatisfied(run.next,run.target)){run.next++;run.done++;}
    if(run.next>run.end){
      gameAnalysis=null;analysisMessage=`Analysis complete · ${run.end+1} positions`;
      cursor=run.end;P.replay(board,initial,moves,cursor);result=analysisCache.get(cursor)||null;
      if(result)progress={visits:result.visits,target:result.targetSimulations||run.target,inherited:result.inheritedVisits||0};
      if(run.target<100&&[6,8].includes(side))analysisMessage+=" · use 100 simulations or more to have the key moves marked";
      render();reviewGame();return;
    }
    cursor=run.next;P.replay(board,initial,moves,cursor);result=null;hover=null;render();search("analysis",true);
  },0);
}
function toggleGameAnalysis(){
  if(mode!=="analysis")return;
  if(gameAnalysis){cancelSearch();render();return;}
  if($("moves").value.trim()!==P.serialize(initial,moves).trim()){fail("Load the edited moves before analyzing the game.");return;}
  cancelSearch();clearError();analysisMessage="";
  gameAnalysis={end:moves.length,next:0,done:0,target:prefs.tumbstoneSims};queueGameAnalysis();render();
}
function disposeWorker(){
  stopReview();if(worker)worker.terminate();worker=null;workerKind=null;workerReady=false;engineBackend=null;measuredSpeed=null;lastInference=null;searchedPosition=null;
  if(workerResolve)workerResolve(false);workerResolve=null;workerPromise=null;
}
async function ensureWorker(kind){
  if(worker&&workerKind===kind)return workerReady?true:workerPromise;
  const pendingExplanation=explaining,pendingReview=reviewRun;
  disposeWorker();explaining=pendingExplanation;reviewRun=pendingReview;workerKind=kind;
  const path=new URL(kind==="highnoon"?"highnoon-worker.js":kind==="human"?"human-worker.js":"search-worker.js",location.href);path.searchParams.set("size",side);path.searchParams.set("engine",kind);
  if(kind==="human"&&browserHuman)path.searchParams.set("backend","browser");
  if(url.searchParams.has("ep"))path.searchParams.set("ep",url.searchParams.get("ep"));
  if(url.searchParams.get("batch")==="1")path.searchParams.set("batch","1");
  if(["original","flat"].includes(url.searchParams.get("matrix")))path.searchParams.set("matrix",url.searchParams.get("matrix"));
  if(url.searchParams.get("scan")==="parallel")path.searchParams.set("scan","parallel");
  const created=new Worker(path);worker=created;
  workerPromise=new Promise(resolve=>workerResolve=resolve);
  created.onmessage=async event=>{if(worker!==created)return;const d=event.data;
    if(d.type==="review-progress"){reviewCalls.get(d.id)?.progress(d.done,d.total);return;}
    if(d.type==="review-done"){
      const call=reviewCalls.get(d.id);reviewCalls.delete(d.id);
      if(call)d.error?call.reject(new Error(d.error)):d.stopped?call.reject(new Error("stopped")):call.resolve(d.out);
      return;
    }
    if(d.type==="loading"){$("engine-status").textContent=d.message;return;}
    if(d.type==="ready"){
      workerReady=true;engineBackend=d.backend;$("engine-status").textContent=d.model_label;
      scanImplementation=d.scanImplementation||"sequential";
      if(url.searchParams.get("profile")==="1"&&d.backend==="webgpu"&&navigator.gpu)
        navigator.gpu.requestAdapter().then(adapter=>{gpuHalfPrecision=adapter?.features.has("shader-f16")??null;render();}).catch(()=>{});
      if(workerResolve)workerResolve(true);workerResolve=null;return;
    }
    if(d.type==="backend-changed"){engineBackend=d.backend;scanImplementation="sequential";measuredSpeed=null;$("engine-status").textContent=d.model_label;return;}
    if(d.type==="ownership"){
      // A stopped search may still finish its single initial evaluation. Keep
      // that map only if it belongs to the position still on screen.
      if(mode==="analysis"&&ownershipRequest?.gen===d.gen&&ownershipRequest.key===ownershipKey()){
        ownershipRequest=null;rememberOwnership(d.ownership);drawBoard();
      }
      return;
    }
    if(d.type==="error"){
      if(d.gen!==undefined&&d.gen!==task?.id)return;
      fail(d.message);cancelSearch();if(workerResolve)workerResolve(false);workerResolve=null;render();return;
    }
    if(!task||d.gen!==task.id||!["progress","done"].includes(d.type))return;
    result=d;if(task.purpose==="analysis"&&d.visits>0){rememberOwnership(d.ownership);ownershipRequest=null;}
    if(d.simulations>0&&d.ms>0)measuredSpeed=d.simulations*1000/d.ms;
    if(d.inference)lastInference={inference:d.inference,ms:d.ms};
    rememberAnalysis(d,task);progress={visits:d.visits||0,target:d.targetSimulations||task.target,inherited:d.inheritedVisits||0};render();
    if(d.type!=="done")return;
    const finished=task;
    if(d.engineComplete&&!d.stopped&&finished.purpose!=="analysis"){
      await waitForThinking(finished.startedAt);
      if(worker!==created||task!==finished)return;
    }
    task=null;$("stop").disabled=true;
    if(!d.engineComplete||d.stopped){stopGameAnalysis();render();return;}
    if(finished.purpose==="analysis"){
      if(gameAnalysis){gameAnalysis.next=finished.index+1;gameAnalysis.done++;queueGameAnalysis();}render();
    }else if(finished.purpose==="play"&&mode==="play"&&cursor===moves.length&&board._hn_stm()===3-humanSide){
      try{applyMove(d.best,true);}catch(e){fail(e);}
    }else if(finished.purpose==="placement"&&mode==="setup"&&stage==="white-search"){
      try{
        initial=P.handicap(side,placements,d.best);P.initialize(board,initial);stage="done";mode="play";humanSide=1;
        result=null;render();
      }catch(e){fail(e);stage="white-ready";render();}
    }else if(finished.purpose==="offer"&&mode==="setup"&&stage==="evaluating"){
      const choosesRed=d.offerPreferRed??((d.offerPreference??d.redMargin)>=0);
      humanSide=choosesRed?2:1;stage="done";mode="play";result=null;render();maybeComputer();
    }
  };
  created.onerror=event=>{if(worker!==created)return;fail(event.message||"The engine stopped unexpectedly.");cancelSearch();if(workerResolve)workerResolve(false);workerResolve=null;render();};
  return workerPromise;
}
async function loadBoard(nextSide){
  const token=++boardToken;loadingBoard=true;cancelSearch();disposeWorker();
  if(board&&side===nextSide){loadingBoard=false;return true;}
  const factory=await new Promise((resolve,reject)=>{
    const script=document.createElement("script");script.src=`rules/side${nextSide}.js`;
    script.onload=()=>{const factory=window.HN;script.remove();resolve(factory);};
    script.onerror=()=>{script.remove();loadingBoard=false;reject(new Error("Could not load board rules."));};document.head.append(script);
  });
  const loaded=await factory();if(token!==boardToken)return false;
  board=loaded;side=nextSide;focusedCell=null;loadingBoard=false;return true;
}
function currentCodes(){return P.cells(side).map(c=>{const owner=board._hn_owner(c);return owner===3?13:owner?board._hn_height(c)+(owner===2?6:0):0;});}
async function search(purpose,keepGameAnalysis=false){
  if(!board||loadingBoard||mode==="editor")return;
  const intendedEngine=purpose==="analysis"?"highnoon":opponent;
  const colourChoice=purpose==="offer"&&intendedEngine==="jesse";
  const positionKey=JSON.stringify([intendedEngine,initial,moves.slice(0,cursor),humanSide,prefs.humanity,purpose==="placement"]);
  const reuseVisits=!colourChoice&&searchedPosition===positionKey&&workerKind===intendedEngine&&intendedEngine!=="frontier"&&result?result.visits||0:0;
  clearError();cancelSearch(keepGameAnalysis);hover=null;result=null;
  const id=generation,kind=purpose==="analysis"?"highnoon":opponent;
  const request={type:"search",gen:id,purpose:purpose==="placement"?"play":purpose,
    initial:structuredClone(initial),moves:moves.slice(0,cursor),sims:effort(kind),profile:prefs.profile,
    strongColour:humanSide?3-humanSide:1,humanity:prefs.humanity,context:"unified",codes:currentCodes()};
  const mapKey=purpose==="analysis"?ownershipKey():null;
  request.preliminaryOwnership=purpose==="analysis"&&!ownershipMaps.has(mapKey)&&!board._hn_score(2);
  ownershipRequest=request.preliminaryOwnership?{gen:id,key:mapKey,request}:null;
  if(purpose==="placement"){request.placement="white";request.strongColour=2;}
  if(kind==="frontier")request.fresh=true;
  const target=colourChoice?2*request.sims:request.sims;
  progress={visits:kind!=="frontier"&&request.sims!==1?reuseVisits:0,target,inherited:kind!=="frontier"&&request.sims!==1?reuseVisits:0};
  task={id,purpose,target,index:cursor,startedAt:performance.now()};$("stop").disabled=false;render();
  if(!await ensureWorker(kind))return;
  if(task?.id!==id){
    // Stop during model loading still permits the one evaluation needed to
    // draw this position. Navigation to another position cancels it entirely.
    if(mode!=="analysis"||ownershipRequest?.gen!==id||ownershipRequest.key!==ownershipKey())return;
    request.sims=1;request.fullBudget=true;
  }
  searchedPosition=positionKey;
  worker.postMessage(request);
}
function maybeComputer(){if(!welcomeOpen&&mode==="play"&&!playFinished&&cursor===moves.length&&humanSide&&board._hn_stm()!==humanSide&&!board._hn_score(2))search("play");}
function moveSound(){
  if(!prefs.sound)return;
  try{audio ||= new (window.AudioContext||window.webkitAudioContext)();audio.resume();const o=audio.createOscillator(),g=audio.createGain();
    o.frequency.setValueAtTime(140,audio.currentTime);o.frequency.exponentialRampToValueAtTime(70,audio.currentTime+.07);
    g.gain.setValueAtTime(.1,audio.currentTime);g.gain.exponentialRampToValueAtTime(.0001,audio.currentTime+.1);
    o.connect(g);g.connect(audio.destination);o.onended=()=>{o.disconnect();g.disconnect();};o.start();o.stop(audio.currentTime+.11);
  }catch{}
}
function applyMove(move,computer=false){
  if(mode==="play"&&playFinished)return;
  if(mode!=="analysis"&&!(mode==="play"&&cursor===moves.length&&(computer||board._hn_stm()===humanSide)))return;
  P.play(board,move);cancelSearch();moves=moves.slice(0,cursor);moves.push(move);cursor=moves.length;
  trimAnalysis(cursor);
  result=null;hover=null;moveSound();render();if(mode==="analysis")search("analysis");else maybeComputer();
}
function beginPlay(colour){cancelSearch();humanSide=colour;mode="play";stage="done";result=null;render();maybeComputer();}
function updateSetupBoard(){
  initial=P.blank(side);
  if(handicap){initial.stacks.push(...placements.map(c=>[c,1,1]));initial.turn=placements.length===handicap?2:1;}
  else initial.stacks.push(...placements.map((c,i)=>[c,i+1,1]));
  P.initialize(board,initial);render();
}
async function newGame(selection){
  cancelSearch();clearError();const nextSide=Number(selection.side??selection.size),setup=Number(selection.opening);
  if(![6,8].includes(nextSide)||!opponents.includes(selection.opponent)||![0,4].includes(setup)||selection.opponent!=="highnoon"&&nextSide!==8)throw new Error("Choose an available opponent and board size.");
  if(selection.opponent==="human"&&!humanProfiles.some(p=>p.key===(selection.profile||prefs.profile)))throw new Error("Choose an available human opponent.");
  if(!await loadBoard(nextSide))return;
  opponent=selection.opponent;handicap=opponent==="jesse"?challengeProgress.handicap:0;mode="setup";stage="placing";
  playFinished=null;savedPlay=null;
  challenge=opponent==="jesse"?{id:crypto.randomUUID(),handicap,completed:false}:null;
  humanSide=0;placements=[];moves=[];cursor=0;result=null;hover=null;clearAnalysis();editingBackup=null;
  prefs={...prefs,side,opponent,opening:setup,profile:selection.profile||prefs.profile};savePrefs();
  const next=new URL(location.href);next.searchParams.set("size",side);next.searchParams.delete("game");history.replaceState(null,"",next);
  updateSetupBoard();
  if(setup===4){
    enterEditor();editingBackup.newCustom=true;
    board._hn_set_turn(prefs.customTurn);$("editor-turn").value=prefs.customTurn;
    $("editor-engine").value=prefs.customEngine;render();
  }
}
function chooseCell(cell){
  clearError();if(!board||loadingBoard)return;
  if($("board").getAttribute("aria-busy")==="true")return;
  try{
    if(mode==="editor"){
      editUndo.push(P.snapshot(board));if(editUndo.length>200)editUndo.shift();
      const owner=Number(document.querySelector('input[name="brush"]:checked').value),height=owner===0?0:owner===3?2:Number($("stack-height").value);
      if(!board._hn_set_stack(cell,owner,height))throw new Error("Choose a stack height from 1 to 6.");render();return;
    }
    if(mode==="setup"&&stage==="placing"){
      if(board._hn_owner(cell))return;
      placements.push(cell);updateSetupBoard();
      if(handicap&&placements.length===handicap){initial=P.handicap(side,placements);P.initialize(board,initial);stage="white-ready";}
      if(!handicap&&placements.length===2){initial=P.opening(side,...placements);P.initialize(board,initial);stage="offer-ready";}
      render();return;
    }
    if(mode==="setup"&&stage==="choose"){
      if(board._hn_stm()!==1||board._hn_value(cell)<=0)return;
      beginPlay(1);
    }
    applyMove(cell);
  }catch(e){fail(e);}
}
async function setupByComputer(){
  if(handicap||mode!=="setup"||stage!=="placing")return;
  const startedAt=performance.now(),controller=new AbortController();
  setupRequest=controller;stage="offering";render();
  try{
    let start;
    if(opponent==="human"&&browserHuman){
      start=browserHuman.setup(prefs.profile);
    }else if(opponent==="human"){
      const response=await fetch("/api/human",{method:"POST",signal:controller.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"setup",profile:prefs.profile})});
      const answer=await response.json();if(!response.ok)throw new Error(answer.error||"Could not set up a game.");
      start=answer.start;
    }else{
      const starts=OPENING_CONFIG.balancedStartsBySize[side];
      const values=new Uint32Array(1);crypto.getRandomValues(values);
      start=starts[values[0]%starts.length].split(" ").map(x=>P.parseCell(side,x));
    }
    await waitForThinking(startedAt);
    if(setupRequest!==controller)return;
    placements=start;initial=P.opening(side,...placements);P.initialize(board,initial);stage="choose";result=null;render();
  }catch(error){
    if(setupRequest===controller&&error.name!=="AbortError"){stage="placing";fail(error);render();}
  }finally{
    if(setupRequest===controller)setupRequest=null;
  }
}
function enterAnalysis(){
  if(mode==="editor"){commitEditor(true);return;}
  if(mode==="analysis")return;
  savedPlay=stoppedPlaySnapshot();
  if(mode==="setup"){
    cancelSearch();
    const start=OPENING_CONFIG.balancedStartsBySize[side][0].split(" ").map(c=>P.parseCell(side,c));
    initial=P.opening(side,...start);moves=[];cursor=0;P.initialize(board,initial);
  }
  cancelSearch();mode="analysis";result=null;render();search("analysis");
}
function review(next){
  if(mode==="setup"||mode==="editor")return;
  if(reviewRun){   // a whole review is being made: look at the game without stopping it (the engine is busy with it)
    cursor=Math.max(0,Math.min(moves.length,next));P.replay(board,initial,moves,cursor);
    result=mode==="analysis"&&analysisSatisfied(cursor,prefs.tumbstoneSims)?analysisCache.get(cursor)||null:null;
    hover=null;if(result)progress={visits:result.visits,target:result.targetSimulations||prefs.tumbstoneSims,inherited:result.inheritedVisits||0};
    render();return;
  }
  cancelSearch();cursor=Math.max(0,Math.min(moves.length,next));P.replay(board,initial,moves,cursor);
  result=mode==="analysis"&&analysisSatisfied(cursor,prefs.tumbstoneSims)?analysisCache.get(cursor)||null:null;
  hover=null;if(result)progress={visits:result.visits,target:result.targetSimulations||prefs.tumbstoneSims,inherited:result.inheritedVisits||0};
  render();if(mode==="analysis"&&!result)search("analysis");
}
function enterEditor(){
  if(!board||mode==="editor")return;
  cancelSearch();editingBackup={initial:structuredClone(initial),moves:[...moves],cursor,mode,stage,placements:[...placements],humanSide,handicap};
  editUndo=[];mode="editor";result=null;hover=null;
  $("editor-turn").value=board._hn_stm();$("editor-engine").value=humanSide?3-humanSide:prefs.customEngine;render();
}
function commitEditor(analyze){
  try{
    board._hn_set_turn(Number($("editor-turn").value));initial=P.snapshot(board);P.validate(initial);
    if(!analyze)savedPlay=null;
    moves=[];cursor=0;placements=[];handicap=0;humanSide=3-Number($("editor-engine").value);challenge=null;playFinished=null;
    prefs.customEngine=3-humanSide;prefs.customTurn=board._hn_stm();savePrefs();
    mode=analyze?"analysis":"play";stage="done";editingBackup=null;result=null;hover=null;clearAnalysis();render();
    if(analyze)search("analysis");else maybeComputer();
  }catch(e){fail(e);}
}
async function cancelEditor(){
  if(!editingBackup)return;const b=editingBackup;
  if(b.initial.side!==side)await loadBoard(b.initial.side);
  ({initial,moves,cursor,mode,stage,placements,humanSide,handicap}=b);editingBackup=null;result=null;
  if(mode==="setup")P.initialize(board,initial);else P.replay(board,initial,moves,cursor);render();
  if(b.newCustom)$("new-game").click();
}
// One question to the worker for the review; the answer comes back by its id.
function reviewCall(message,progress=()=>{}){
  return new Promise((resolve,reject)=>{const id=++reviewSerial;reviewCalls.set(id,{resolve,reject,progress});worker.postMessage({...message,id});});
}
// The engine as review-sheets.js wants it. `known` holds answers that need no search (the position already
// analyzed); legal moves come from the review's own rules, which give the engine's list.
function reviewEngine(b,known,run){
  const stage=(phase,done,total)=>{if(explaining===run){run.phase=phase;run.done=done;run.total=total;render();}};
  return {
    async search(jobs,visits,pvLength=10){
      const out=new Array(jobs.length),todo=[];
      jobs.forEach(([codes,stm],k)=>{const hit=known.get(JSON.stringify([Array.from(codes),stm]));if(hit)out[k]=hit;else todo.push(k);});
      if(todo.length){
        const phase=visits===REVIEW.threatVisits?"Looking for threats":todo.length===1?"Searching the position":"Searching both moves";stage(phase,0,todo.length);
        const found=await reviewCall({type:"review-search",jobs:todo.map(k=>[Array.from(jobs[k][0]),jobs[k][1]]),visits,pvLength},(done,total)=>stage(phase,done,total));
        todo.forEach((k,i)=>{out[k]=found[i];});
      }
      return out;
    },
    async evaluate(codes,stm){
      const found=await reviewCall({type:"review-evaluate",codes:codes.map(c=>Array.from(c)),stm:Array.from(stm)});
      return {policy:found.policy.map(row=>Float32Array.from(row)),own:found.own.map(row=>Float32Array.from(row))};
    },
    legal(codes,stm){return [...new Review.board.Position(b,codes,stm).canPlace(stm,true).keys()].map(i=>b.cells[i]);},
  };
}
// One of the engine's two lines of an explained move, move by move, for playing it out on the board (berndr361,
// November 10): the stacks changed so far, by the page's cell numbers.
function lineSteps(b,position,line){
  const out=[],cells=new Map();let p=position;
  for(const name of [line.first,...line.line]){
    const passed=!name||/pass/i.test(name),m=passed?null:b.index(name),q=p.after(m);
    if(m!==null)cells.set(b.cells[m],[Review.board.owner(q.codes[m]),Review.board.height(q.codes[m])]);
    out.push({move:passed?"pass":name,by:p.stm,cell:m===null?null:b.cells[m],cells:new Map(cells)});
    p=q;
  }
  return out;
}
async function explainMove(){
  if(mode!=="analysis"||!board||loadingBoard||cursor>=moves.length||![6,8].includes(side))return;
  const index=cursor,deep=result?.visits>=REVIEW.visits||result?.earlyStopped&&result.targetSimulations>=REVIEW.visits;   // a search that stopped early had settled its move
  const marked=gameReview?.praise.includes(index);   // a good move was chosen on this analysis: no deeper search to say what it does
  const current=result?.type==="done"&&result.engineComplete&&!result.policyOnly&&(deep||marked)&&result.best>=0?result:null;
  cancelSearch();clearError();
  const run={index,phase:"Starting",done:0,total:1};explaining=run;render();
  try{
    if(!await ensureWorker("highnoon")||explaining!==run)return;
    searchedPosition=null;   // the review's searches replace the tree the worker kept
    const R=Review,b=new R.board.Board(side),compact=m=>m<0?null:b.compact[m];
    P.replay(board,initial,moves,index);const codes=currentCodes(),stm=board._hn_stm();P.replay(board,initial,moves,cursor);
    const p=new R.board.Position(b,codes,stm),move=compact(moves[index]);
    const prev=index>0?compact(moves[index-1]):initial.kind==="normal"?b.compact[initial.white]:null;
    const known=new Map(),engine=reviewEngine(b,known,run),key=JSON.stringify([codes,stm]),ply=index+numberOffset();
    // the better move is the one analysis shows when this position has been searched at least as deeply
    const parent=current?{terminal:false,best:current.best,candidates:current.candidates}:(await engine.search([[codes,stm]],REVIEW.visits))[0];
    known.set(key,parent);
    const game={side,players:{1:"Red",2:"White"}},name=cname(moves[index]);
    let entry;
    if(parent.terminal||parent.best===null){
      entry={kind:"note",lines:["The game is settled here: no move changes the result."]};
    }else if(move===b.compact[parent.best]){
      const margins=parent.candidates.filter(c=>c.move!==parent.best&&c.visits>=3&&Number.isFinite(c.margin)).map(c=>c.margin);
      const top=parent.candidates.find(c=>c.move===parent.best);
      const sheet=await R.sheets.praiseSheet(engine,b,game,{ply,gap:margins.length&&top?top.margin-Math.max(...margins):0},[codes,stm,move],prev);
      sheet.side=side;
      // what the move leads to: one search of the position after it, also for playing the line out on the board
      await R.sheets.praisePayoffs(engine,b,new Map([[ply,p]]),[sheet],REVIEW.visits);
      entry={kind:"good",lines:R.words.praiseText(sheet,1).split("\n  "),sheet};
      if(sheet.payoff?.line?.length)entry.steps=[lineSteps(b,p,{first:name,line:sheet.payoff.line})];
    }else{
      const at=new Map([[ply,[codes,stm,move]]]);
      if(index+1<moves.length){const q=p.after(move);at.set(ply+1,[q.codes,q.stm,compact(moves[index+1])]);}
      const sheet=(await R.sheets.searchedSheets(engine,b,game,at,new Map([[ply,prev]]),[ply],REVIEW.visits,REVIEW.threatVisits))[0];
      sheet.side=side;
      if(gameReview){sheet.decided=gameReview.done.has(index);sheet.close=gameReview.close.has(index);}
      const reply=gameReview?.rows.get(index+1)?.loss??costlyLoss(index+1);
      sheet.next=index+1<moves.length?{move:moves[index+1]<0?"a pass":cname(moves[index+1]),loss:Number.isFinite(reply)?Math.max(0,reply):0}:null;
      if(sheet.loss<1){
        const ahead=Math.round(-sheet.loss);
        entry={kind:"note",sheet,lines:[ahead>=1
          ?`Searched alike, ${name} comes out about ${ahead} ${ahead===1?"point":"points"} ahead of ${sheet.best.cell}, the engine's first choice here: there is nothing to correct.`
          :`${name} is as good as the engine's ${sheet.best.cell} here: searched alike, the two moves come out within a point of each other.`]};
      }else{
        const words=R.words.plainEdges(R.words.commentary(sheet,new R.words.Used()),side);
        const [main,details]=R.words.entryParts(words);
        entry={kind:R.words.mark(sheet,words),lines:main,details,sheet};
        if(sheet.lines?.played&&sheet.lines?.best)entry.steps=[sheet.lines.played,sheet.lines.best].map(line=>lineSteps(b,p,line));
      }
    }
    if(explaining!==run)return;
    entry.lines[0]=entry.lines[0].replace(/^(Move \d+), (Red|White) \([^)]*\): /,"$1, $2: ");
    explanations.set(index,entry);explaining=null;sideTab="move";
    if(cursor===index&&entry.sheet?.lines)boardView="difference";
    render();if(cursor===index)$("explain-panel").scrollIntoView({block:"nearest",behavior:"smooth"});if(cursor===index&&!result)search("analysis");
  }catch(e){
    if(explaining===run){explaining=null;if(e.message!=="stopped")fail(e);render();}
  }
}
// What a move cost by the plotted margins, when both positions around it have been analyzed.
function costlyLoss(i){
  if(i>=moves.length||!analysisRecords.get(i)?.complete||!analysisRecords.get(i+1)?.complete)return NaN;
  return ((initial.turn-1+i)%2===0?1:-1)*(marginHistory.get(i)-marginHistory.get(i+1));
}
function ownershipColor(value){
  if(!Number.isFinite(value))value=0;
  const a=Math.min(1,Math.abs(value)),end=value>=0?[186,66,56]:[255,255,255],base=[229,221,202];
  return `rgb(${end.map((v,i)=>Math.round((base[i]+v*a)/2)).join(",")})`;
}
function marginLossColor(loss){
  if(loss<0)return "rgb(149,106,199)";
  const from=loss<=5?[79,156,104]:[230,185,82],to=loss<=5?[230,185,82]:[207,87,76],a=Math.min(1,loss<=5?loss/5:(loss-5)/5);
  return `rgb(${from.map((v,i)=>Math.round(v+(to[i]-v)*a)).join(",")})`;
}
// The move played from this position against the engine's choice (or the
// candidate under the pointer): the search's ownership after each, cell by
// cell, from the mover's side. After the move played it is the whole tree of
// the next position when that has been analyzed, else that move's subtree here.
function moveDifference(){
  if(mode!=="analysis"||!board)return null;
  if(!result?.candidates?.length)return {note:"Waiting for the search of this position."};
  const byMove=new Map(result.candidates.map(c=>[c.move,c]));
  const selected=pinnedCandidate===null?null:byMove.get(pinnedCandidate);
  const played=selected?selected.move:moves[cursor],other=byMove.get(result.best);
  if(played===undefined)return {note:"Select a candidate to compare it with HighNoon's best move."};
  if(!other?.samples)return {note:"Waiting for the search of this position."};
  if(other.move===played)return {note:`${cname(played)} is the engine's choice here.`};
  const lines=!selected&&explanations.get(cursor)?.sheet?.lines;
  if(lines){                                  // the explanation's own searches, so the board shows what the text says
    const cells=P.cells(side),delta=new Float32Array(P.grid(side)**2);
    cells.forEach((cell,i)=>{delta[cell]=lines.delta[i];});
    return {played,other:P.parseCell(side,lines.best.first),engine:true,delta,total:lines.total,mover:board._hn_stm()===1?"Red":"White",thin:false};
  }
  const next=!selected?analysisCache.get(cursor+1):null,here=byMove.get(played);
  const after=next?.rootOwnership&&next.visits?next.rootOwnership:here?.samples?here.ownership:null;
  if(!after)return {note:`Step forward once, or use Analyze game, to search the position after ${cname(played)}.`};
  const sign=board._hn_stm()===1?1:-1,delta=new Float32Array(after.length);let total=0;
  for(const cell of P.cells(side)){delta[cell]=sign*(other.ownership[cell]-after[cell]);total+=delta[cell];}
  return {played,other:other.move,engine:true,preview:!!selected,delta,total,mover:board._hn_stm()===1?"Red":"White",
    thin:other.samples<50||!(next?.rootOwnership&&next.visits>=50)&&!(here?.samples>=50)};
}
function differenceColor(value){
  const a=Math.abs(value)<.1?0:Math.min(1,2*Math.abs(value))*.8,end=value>0?[46,125,50]:[36,109,204],base=[238,233,221];
  return `rgb(${base.map((v,i)=>Math.round(v+(end[i]-v)*a)).join(",")})`;
}
// The moves of an analyzed game that the review would comment on, for the marks on the plot: its mistakes and
// good moves, chosen by the review's own rules (review-select.js) from the analysis of every position. A mark
// shows ✗ or ? by what the analysis says the move cost; once the move has been explained, by its explanation.
function reviewMarks(){
  if(shownReview)return [...explanations.entries()].filter(([,e])=>e.sheet).map(([i,e])=>({index:i,mover:e.sheet.colour==="White"?2:1,loss:e.sheet.loss||0,kind:e.kind})).sort((a,b)=>a.index-b.index);
  if(!gameReview)return [];
  const out=[];
  for(const i of gameReview.chosen){
    const r=gameReview.rows.get(i),e=explanations.get(i);
    const big=r.loss>=5||r.win_loss>=.12,soft=gameReview.done.has(i)&&r.win_best>=.5;   // as review-words.js marks an entry
    out.push({index:i,mover:r.stm,loss:r.loss,kind:e?e.kind:big&&!soft?"mistake":"dubious"});
  }
  for(const i of gameReview.praise)if(!gameReview.chosen.includes(i))out.push({index:i,mover:gameReview.rows.get(i).stm,loss:0,kind:explanations.get(i)?.kind||"good"});
  return out.sort((a,b)=>a.index-b.index);
}
const MARK_SIGN={mistake:"✗",dubious:"?",good:"✓",note:"="},MARK_NAME={mistake:"mistake",dubious:"questionable move",good:"good move",note:"as good as the engine's move"};
// The review's choice of moves, once every position of the game has been analyzed with at least 100 simulations:
// what each move cost (the engine's move in the position's own search against the search of the position after
// the move played, as the review's scoring pass has it), winning chances from the points still in play (one
// network evaluation of every position), then the review's rules for mistakes and for good moves.
// Show a review: its entries become the explanations of their moves, its scores fill the plot where analysis has
// none, and the Game tab opens. parts: the parts a review being made has so far (see Review.view.PARTS); open:
// false leaves the reader on the tab they are on.
function showReview(r,parts=null,open=true){
  const R=Review,b=new R.board.Board(side),off=numberOffset(),at=[];
  P.replay(board,initial,moves,0);let p=new R.board.Position(b,currentCodes(),board._hn_stm());P.replay(board,initial,moves,cursor);
  for(const m of moves){at.push(p);p=p.after(m<0?null:b.compact[m]);}
  shownReview=r;shownParts=parts;shownSerial++;gameReview=null;explanations.clear();
  for(const e of !parts||parts.includes("entries")?R.view.entries(r):[]){
    const i=e.ply-off;if(i<0||i>=moves.length)continue;
    const entry={kind:e.kind,lines:e.lines,details:e.details,sheet:e.sheet};e.sheet.side=side;
    if(e.kind==="good"){if(e.sheet.payoff?.line?.length)entry.steps=[lineSteps(b,at[i],{first:e.cell,line:e.sheet.payoff.line})];}
    else if(e.sheet.lines?.played&&e.sheet.lines?.best)entry.steps=[e.sheet.lines.played,e.sheet.lines.best].map(line=>lineSteps(b,at[i],line));
    explanations.set(i,entry);
  }
  for(const t of r.timeline||[]){const i=t.ply-off;if(i>=0&&i<=moves.length&&!Number.isFinite(marginHistory.get(i)))marginHistory.set(i,t.red_value);}
  if(open)sideTab="game";
  render();
}
// A saved review (the JSON the review tool writes): its game is loaded and the review shown, with no engine.
async function loadReview(r){
  if(![6,8].includes(r?.game?.side)||!Array.isArray(r.game.moves)||!Array.isArray(r.timeline))throw new Error("This is not a saved review.");
  if(r.game.side!==side)await loadBoard(r.game.side);
  await loadText(r.game.moves.map(m=>m[0]==="PASS"?"pass":`${m[0]}${m[1]}`).join(" "));
  r.game.players={1:r.game.players[1]??r.game.players["1"],2:r.game.players[2]??r.game.players["2"]};
  showReview(r);
}
// The engine for a whole review: answers are kept by position and effort, and searches go in parts, so a review
// that was stopped goes on from where it was.
function wholeEngine(b,run){
  const stage=(phase,done,total)=>{if(explaining===run){run.phase=phase;run.done=done;run.total=total;render();}};
  const key=(codes,stm,visits,pv)=>JSON.stringify([side,Array.from(codes),stm,visits,pv]);
  const plain=reviewEngine(b,new Map(),run);
  return {
    async search(jobs,visits,pvLength=10){
      const out=new Array(jobs.length),todo=[];
      jobs.forEach(([codes,stm],k)=>{const hit=reviewAnswers.get(key(codes,stm,visits,pvLength));if(hit)out[k]=structuredClone(hit);else todo.push(k);});
      const phase=visits===REVIEW.threatVisits?"Looking for threats":visits<REVIEW.visits?"Scoring every move":"Searching the moves that matter",size=visits===1?512:visits<REVIEW.visits?24:4;   // a stopped review loses the part it was in
      for(let s=0;s<todo.length;s+=size){
        const part=todo.slice(s,s+size);stage(phase,s,todo.length);
        const found=await reviewCall({type:"review-search",jobs:part.map(k=>[Array.from(jobs[k][0]),jobs[k][1]]),visits,pvLength},done=>stage(phase,s+done,todo.length));
        part.forEach((k,i)=>{out[k]=found[i];reviewAnswers.set(key(jobs[k][0],jobs[k][1],visits,pvLength),structuredClone(found[i]));});
      }
      return out;
    },
    evaluate:plain.evaluate,legal:plain.legal,
  };
}
// The whole review of the game on the board, made here with the review tool's own code: the scoring pass, the
// entries, the deeper searches, the story. Each part is shown as soon as its text will not change any more.
// Pressed again while it runs, it stops; what was found is kept, and the next press goes on from there.
async function runReview(){
  if(reviewRun){cancelSearch();render();if(!result)search("analysis");return;}
  if(mode!=="analysis"||!board||loadingBoard||![6,8].includes(side)||initial.kind!=="normal"||moves.length<10)return;
  cancelSearch();clearError();
  const run={index:-1,phase:"Starting",done:0,total:1};explaining=run;reviewRun=run;render();
  try{
    if(!await ensureWorker("highnoon")||explaining!==run)return;
    searchedPosition=null;
    const R=Review,b=new R.board.Board(side),compact=m=>m<0?null:b.compact[m];
    P.replay(board,initial,moves,moves.length);const over=!!board._hn_score(2);
    P.replay(board,initial,moves,0);const setup=[currentCodes(),board._hn_stm()];P.replay(board,initial,moves,cursor);
    let p=new R.board.Position(b,setup[0],setup[1]);const positions=[];
    moves.forEach((m,i)=>{positions.push([i+2,p.codes,p.stm,compact(m)]);p=p.after(compact(m));});
    // the count as it stands on the last position, finished or not: a stack each, and each empty cell to the side that sees it more.
    // Nobody has won a game that is not over: the review then says that it is not finished, and gives the count.
    const owner=R.sheets.finalOwner(p),red=owner.filter(v=>v>0).length,white=owner.filter(v=>v<0).length;
    const cell=c=>{const n=cname(c);return [n[0],n.slice(1),1];},winner=!over?null:red>white?1:white>red?2:null;
    const game={id:null,side,title:"Red vs. White",players:{1:"Red",2:"White"},result:null,winner:null,pie:true,
      moves:[cell(initial.red),cell(initial.white),...moves.map(m=>m<0?["PASS","",0]:cell(m))]};
    const rules={positions,setup,final:{winner,over,result:[{name:"Red",colour:"red",score:red,winner:winner===1},{name:"White",colour:"white",score:white,winner:winner===2}]}};
    const onPart=(sofar,parts)=>{if(explaining===run){showReview(sofar,parts,!run.shown);run.shown=true;}};
    const r=await R.sheets.review(game,rules,wholeEngine(b,run),{visits:REVIEW.visits,threatVisits:REVIEW.threatVisits,onPart});
    if(explaining!==run)return;
    explaining=null;reviewRun=null;showReview(r,null,!run.shown);if(!result)search("analysis");
  }catch(e){
    if(explaining===run){explaining=null;reviewRun=null;if(e.message!=="stopped")fail(e);render();}
  }
}
// A press on a move number of the review, or on one of its key moves: the position that move was played in.
function openMove(number,entry){
  const i=number-1-numberOffset();if(i<0||i>moves.length)return;
  review(i);
  if(entry||explanations.has(i)){sideTab="move";if(explanations.get(i)?.sheet?.lines)boardView="difference";render();}
}
async function reviewGame(){
  if(mode!=="analysis"||!board||![6,8].includes(side)||!moves.length||explaining)return;
  const reports=[];
  for(let i=0;i<=moves.length;i++){
    const a=analysisCache.get(i),record=analysisRecords.get(i);
    if(!a||!record?.complete||a.policyOnly||!(record.exact||record.target>=100))return;
    reports.push(a);
  }
  const run={index:-1,phase:"Choosing the moves to explain",done:0,total:1};explaining=run;render();
  try{
    if(!await ensureWorker("highnoon")||explaining!==run)return;
    searchedPosition=null;
    const R=Review,b=new R.board.Board(side),compact=m=>m<0?null:b.compact[m];
    P.replay(board,initial,moves,moves.length);
    const finished=!!board._hn_score(2)||moves.length>=2&&moves.at(-1)<0&&moves.at(-2)<0;
    P.replay(board,initial,moves,0);let p=new R.board.Position(b,currentCodes(),board._hn_stm());
    P.replay(board,initial,moves,cursor);
    const positions=[];
    for(const move of moves){positions.push(p);p=p.after(compact(move));}
    const rows=new Map();
    positions.forEach((p,i)=>{
      const a=reports[i],sign=p.stm===1?1:-1,top=a.candidates.find(c=>c.move===a.best);
      if(a.best<0||!top?.visits)return;
      const others=a.candidates.filter(c=>c.move!==a.best&&c.visits>=3).map(c=>c.margin);
      const played=moves[i]===a.best?top.margin:sign*reports[i+1].rootRedMargin;
      rows.set(i,{ply:i,stm:p.stm,move:compact(moves[i]),value:sign*a.rootRedMargin,best:b.compact[a.best],best_value:top.margin,
        second_value:others.length?Math.max(...others):null,legal:a.candidates.length,played_value:played,loss:Math.max(0,top.margin-played)});
    });
    const {own}=await reviewEngine(b,new Map(),run).evaluate(positions.map(p=>p.codes),positions.map(p=>p.stm));
    if(explaining!==run)return;
    R.select.annotate(rows,new Map(positions.map((_,i)=>[i,R.select.inPlay(own[i])])));
    const chosen=R.select.chooseMistakes(rows,4,2.0,finished),done=R.select.settled(rows),close=R.select.closeFinish(rows,finished);
    // good moves: the engine's choice in an open game that does three things or more, or stands three points
    // clear of the other moves; two a side; not the plain recapture of the stack just placed
    const praise=[];
    for(const stm of [1,2]){
      const found=[];
      for(const r of rows.values()){
        if(r.stm!==stm||r.move===null||r.move!==r.best||r.legal<8||done.has(r.ply))continue;
        const i=r.ply,gap=r.second_value!==null?r.best_value-r.second_value:0;
        const prev=i>0?compact(moves[i-1]):initial.kind==="normal"?b.compact[initial.white]:null;
        const facts=R.detect.moveFacts(positions[i],r.move,own[i],prev,true),purposes=facts.purposes||0;
        if(gap>=3||purposes>=3)found.push({index:i,score:gap+2*purposes,recapture:facts.kind==="capture"&&i>0&&moves[i-1]===moves[i]});
      }
      found.sort((x,y)=>y.score-x.score);
      praise.push(...found.slice(0,2).filter(c=>!c.recapture).map(c=>c.index));
    }
    gameReview={rows,done,close,chosen,praise,finished};explaining=null;
    const marked=reviewMarks().length;
    analysisMessage=`Analysis complete · ${moves.length+1} positions · ${marked?`${marked} moves marked on the plot`:"no move stands out"}`;
    render();
  }catch(e){
    if(explaining===run){explaining=null;if(e.message!=="stopped")fail(e);render();}
  }
}
function displayedCandidates(){
  const all=result?.candidates||[];
  return result?.policyOnly?[...all].sort((a,b)=>b.prior-a.prior):all.filter(c=>c.visits>0);
}
function drawBoard(){
  if(!board)return;
  $("clear-preview").hidden=pinnedCandidate===null;
  const n=P.grid(side),mid=side-1,radius=136.5/(side-1),xy=c=>[300+(c%n-mid-(Math.floor(c/n)-mid)/2)*radius*1.78,277+(Math.floor(c/n)-mid)*radius*1.55];
  const hex=(x,y)=>Array.from({length:6},(_,i)=>{const a=(i*60+30)*Math.PI/180;return(i?"L":"M")+(x+radius*Math.cos(a))+","+(y+radius*Math.sin(a));}).join("")+"Z";
  const settled=mode!=="setup"&&mode!=="editor"&&board._hn_score(2);
  const view=mode==="analysis"?boardView:"normal";
  const candidate=hover===null?null:result?.candidates?.find(c=>c.move===hover);
  const ownership=view==="ownership"?(candidate?.samples?candidate.ownership:result?.ownership||ownershipMaps.get(ownershipKey())):null;
  const waiting=view==="ownership"&&!ownership&&!settled&&!reviewRun;   // no map arrives while a whole review has the engine
  $("board").setAttribute("aria-busy",String(waiting));
  $("board").style.pointerEvents=waiting?"none":"";
  // Replace stacks and colours together. Painting the new position with no
  // map, even for one frame, produces the distracting neutral-board flash.
  if(waiting)return;
  const byMove=new Map((result?.candidates||[]).map(c=>[c.move,c]));
  const difference=view==="difference"?moveDifference():null;
  const top=displayedCandidates(),best=byMove.get(result?.best),total=top.reduce((s,c)=>s+(result.policyOnly?c.prior:c.visits),0);
  $("difference-better").textContent=difference?.delta?`${difference.mover} gets more after ${cname(difference.other)}${difference.engine?" (engine)":""}`:"";
  $("difference-played").textContent=difference?.delta?`after ${cname(difference.played)} (${difference.preview?"preview":"played"})`:"";
  $("difference-note").textContent=difference?.delta?`${cname(difference.other)} is about ${Math.abs(difference.total).toFixed(1)} cells ${difference.total>=0?"better":"worse"}${difference.thin?" · thin search":""}`:difference?.note||"";
  $("preview-context").textContent=view==="difference"?"":mode==="analysis"&&candidate?`After ${cname(candidate.move)} · ${candidate.visits?signed(candidate.margin)+" cells for "+(board._hn_stm()===1?"Red":"White"):"not searched"}`:"";
  let svg="",markers="";const last=mode==="editor"?null:mode==="setup"?placements.at(-1):cursor?moves[cursor-1]:initial.white??null;
  if(linePreview&&(linePreview.index!==cursor||mode!=="analysis"))linePreview=null;
  const shown=linePreview?explanations.get(cursor)?.steps?.[linePreview.line]?.[linePreview.k]:null;
  for(const cell of P.cells(side)){
    const [x,y]=xy(cell),over=shown?.cells.get(cell),owner=over?over[0]:board._hn_owner(cell),height=over?over[1]:board._hn_height(cell);
    if(shown&&cell===shown.cell)markers+=`<path class="annotation line-step" d="${hex(x,y)}" fill="none" stroke="${linePreview.line||explanations.get(cursor).steps.length===1?"#1b5e20":"#246dcc"}" stroke-width="3"/>`;
    const legal=mode==="editor"||(mode==="setup"
      ?stage==="placing"&&!owner||stage==="choose"&&board._hn_stm()===1&&board._hn_value(cell)>0
      :!settled&&board._hn_value(cell)>0&&(mode==="analysis"||mode==="play"&&cursor===moves.length&&board._hn_stm()===humanSide));
    const territory=mode==="editor"||mode==="setup"?0:board._hn_territory(cell);
    let value=ownership?.[cell]??0;if(territory)value=territory===1?1:-1;
    const c=byMove.get(cell),hasMargin=view==="margin"&&c?.visits>0&&Number.isFinite(c.margin);
    const fill=view==="difference"?differenceColor(difference?.delta?.[cell]??0):hasMargin&&best?.visits?marginLossColor(best.margin-c.margin):ownershipColor(value);
    const label=`${cname(cell)}${owner?`, ${["","Red","White","neutral"][owner]} stack ${height}`:", empty"}`;
    svg+=`<path class="hex${legal?" legal":""}${mode==="editor"?" editable":""}" data-cell="${cell}" tabindex="${cell===(focusedCell??0)?0:-1}" role="button" aria-label="${label}" d="${hex(x,y)}" fill="${fill}"></path>`;
    if(owner)svg+=`<circle class="stack" cx="${x}" cy="${y}" r="${radius*.60}" fill="${owner===1?"#ba4238":owner===2?"#fffefa":"#8d8575"}" stroke="#645e53"/><text class="stack-number" x="${x}" y="${y}" fill="${owner===2?"#453b34":"white"}">${height}</text>`;
    if(cell===last||cell===hover)markers+=`<path class="annotation ${cell===hover?"candidate-marker":"last-move-marker"}" d="${hex(x,y)}" fill="none" stroke="${cell===hover?"#24855b":"#e78c25"}" stroke-width="2.5"/>`;
    if(hasMargin)svg+=`<text class="annotation margin-number" x="${x}" y="${y+radius*.82}" text-anchor="middle" font-size="9" fill="#173e2d">${signed(c.margin)}</text>`;
    if(mode==="analysis"&&cell===(view==="difference"&&difference?.delta&&difference.engine?difference.other:result?.best))markers+=view==="difference"?`<path class="annotation recommendation" d="${hex(x,y)}" fill="none" stroke="#1b5e20" stroke-width="3"/>`:`<path class="annotation recommendation" d="${hex(x,y)}" fill="none" stroke="#9859b0" stroke-width="2" stroke-dasharray="4 3"/>`;
    if(mode==="analysis"&&cell===moves[cursor])markers+=`<circle class="annotation played-move" cx="${x}" cy="${y}" r="${radius*.82}" fill="none" stroke="#246dcc" stroke-width="2.5"><title>Played in the game</title></circle>`;
  }
  if(view==="visits"&&total)top.slice(0,8).forEach((c,i)=>{
    if(c.move<0)return;const[x,y]=xy(c.move),share=(result.policyOnly?c.prior:c.visits)/total;
    svg+=`<g class="annotation visit-marker"><circle cx="${x}" cy="${y-radius*.5}" r="${radius*(.23+.4*Math.sqrt(share))}" fill="#e3eed5" stroke="#236949" stroke-width="1.4"/><text x="${x}" y="${y-radius*.5}" text-anchor="middle" dominant-baseline="central" font-size="9" fill="#245738">${i+1}</text><text x="${x}" y="${y+radius*.8}" text-anchor="middle" font-size="9" fill="#245738">${result.policyOnly?share.toFixed(2):c.visits}</text></g>`;
  });
  svg+=`<g class="board-markers" aria-hidden="true">${markers}<path id="board-focus" class="annotation" fill="none" stroke="#267b54" stroke-width="3" stroke-dasharray="5 3" visibility="hidden"/></g>`;
  for(let r=0;r<n;r++){const[x,y]=xy(r*n+Math.max(0,r-mid));svg+=`<text class="coord" x="${x-.83*radius*1.78}" y="${y}">${r+1}</text>`;}
  for(let c=0;c<n;c++){const[x,y]=xy(Math.max(0,c-mid)*n+c),tx=x+.83*radius*.89,ty=y-.83*radius*1.55;svg+=`<text class="coord" x="${tx}" y="${ty}" transform="rotate(30 ${tx} ${ty})">${String.fromCharCode(65+c)}</text>`;}
  const focus=document.activeElement?.closest?.("#board [data-cell]")?.dataset.cell;
  $("board").setAttribute("viewBox","18 26 564 503");$("board").innerHTML=svg;
  if(focus!==undefined)$("board").querySelector(`[data-cell="${focus}"]`)?.focus({preventScroll:true});
  updateBoardFocus();
}
function updateBoardFocus(){
  const marker=$("board-focus"),cell=document.activeElement?.closest?.("#board [data-cell]");
  if(!marker)return;
  const visible=!!cell&&cell.matches(":focus-visible");
  marker.setAttribute("visibility",visible?"visible":"hidden");
  if(visible)marker.setAttribute("d",cell.getAttribute("d"));
}
// The plot is drawn in the pixels of its box, whatever size the layout gives it.
function graphFrame(){
  const box=$("margin-graph").getBoundingClientRect(),W=Math.max(240,Math.round(box.width)||600),H=Math.max(120,Math.round(box.height)||200);
  return {W,H,left:40,right:W-12,top:12,bottom:H-24,x:box.left,y:box.top};
}
function drawGraph(){
  const entries=[...marginHistory.entries()].filter(([i,v])=>i<=moves.length&&Number.isFinite(v));
  const maximum=Math.max(5,...entries.map(([,v])=>Math.abs(v))),step=maximum<=10?2:maximum<=40?10:maximum<=100?25:50;
  const {W,H,left,right,top,bottom}=graphFrame();graphSize=`${W} ${H}`;
  const limit=Math.ceil(maximum/step)*step,zero=(top+bottom)/2;
  const x=i=>moves.length?left+(right-left)*i/moves.length:(left+right)/2,y=v=>zero-v/limit*(bottom-top)/2;
  let svg=`<rect class="margin-red-region" x="${left}" y="${top}" width="${right-left}" height="${zero-top}"/><rect class="margin-white-region" x="${left}" y="${zero}" width="${right-left}" height="${bottom-zero}"/>`;
  for(let tick=-limit;tick<=limit;tick+=step)svg+=`<path class="${tick?"margin-grid":"margin-zero"}" d="M${left} ${y(tick)}H${right}"/><text class="margin-axis-label" x="${left-9}" y="${y(tick)}" text-anchor="end" dominant-baseline="middle">${tick>0?"+":""}${tick}</text>`;
  const moveStep=[1,5,10,20,50].find(s=>moves.length/s<=Math.max(8,(right-left)/55))||50;
  for(let i=0;i<=moves.length;i+=moveStep)
    svg+=`<text class="margin-axis-label margin-move-label" x="${x(i)}" y="${H-6}" text-anchor="middle">${i+numberOffset()}</text>`;
  let previous=null;
  for(let i=0;i<=moves.length;i++){
    const value=marginHistory.get(i),complete=analysisRecords.get(i)?.complete;
    if(Number.isFinite(value)){
      if(previous!==null)svg+=`<path class="margin-line${!complete||!analysisRecords.get(i-1)?.complete?" preliminary":""}" d="M${x(i-1)} ${y(previous)}L${x(i)} ${y(value)}"/>`;
      svg+=`<circle class="margin-point${complete?"":" preliminary"}${i===cursor?" current":""}" data-index="${i}" cx="${x(i)}" cy="${y(value)}" r="3.5" fill="${value>=0?"#ba4238":"#fffdf8"}"><title>After move ${i+numberOffset()}: Red ${signed(value)} cells${complete?"":" · partial search"}</title></circle>`;
      previous=value;
    }else{previous=null;svg+=`<path class="margin-unknown" d="M${x(i)-2} ${zero-2}l4 4m0 -4l-4 4"/>`;}
  }
  const graph=$("margin-graph");
  graphMarks=[];
  if(mode==="analysis")for(const m of reviewMarks()){
    const a=marginHistory.get(m.index),b=marginHistory.get(m.index+1),last=graphMarks.at(-1);
    const mark={...m,x:(x(m.index)+x(m.index+1))/2,y:Math.max(top+9,Math.min(y(a),y(b))-13)};
    if(last&&mark.x-last.x<17&&Math.abs(mark.y-last.y)<17)mark.y=last.y+17<=bottom-9?last.y+17:Math.max(top+9,last.y-17);   // neighbours do not cover each other
    graphMarks.push(mark);
  }
  for(const m of graphMarks)
    svg+=`<g class="margin-mark ${m.kind}${m.index===cursor?" current":""}"><circle cx="${m.x}" cy="${m.y}" r="8"/><text x="${m.x}" y="${m.y}" text-anchor="middle" dominant-baseline="central">${MARK_SIGN[m.kind]}</text><title>Move ${m.index+1+numberOffset()}, ${m.mover===1?"Red":"White"}: ${MARK_NAME[m.kind]}</title></g>`;
  $("graph-note").hidden=!graphMarks.length;
  svg+=`<path class="margin-current" d="M${x(cursor)} ${top}V${bottom}"/>`;
  if(!entries.length)svg+=`<text class="margin-empty" x="${(left+right)/2}" y="${top+26}" text-anchor="middle">Use Analyze game to fill the score plot</text>`;
  const disabled=mode==="setup"||mode==="editor";
  graph.setAttribute("viewBox",`0 0 ${W} ${H}`);graph.innerHTML=svg;graph.setAttribute("aria-valuemax",moves.length);graph.setAttribute("aria-valuenow",cursor);
  graph.setAttribute("aria-disabled",disabled);graph.tabIndex=disabled?-1:0;
  const margin=marginHistory.get(cursor),text=`${cursor?"Move "+(cursor+numberOffset()):"Initial position"} of ${moves.length+numberOffset()}${Number.isFinite(margin)?" · Red "+signed(margin)+" cells":""}`;
  graph.setAttribute("aria-valuetext",text);$("move-number").textContent=text;
}
function render(){
  if(!board)return;
  if(mode==="play"&&cursor===moves.length&&board._hn_score(2)){
    if(!playFinished)finishPlay(board._hn_score(humanSide===1?0:1)>board._hn_score(humanSide===1?1:0));
    // Completed games saved before the result banner did not store their scores.
    if(!playFinished.resigned){playFinished.red=board._hn_score(0);playFinished.white=board._hn_score(1);}
  }
  const setup=mode==="setup",editor=mode==="editor",analysis=mode==="analysis",kind=currentEngine();
  $("active-avatar").src=kind==="human"?humanProfile()?.avatar||"avatars/unknown.jpg":`avatars/${avatars[kind]}.png`;$("active-name").textContent=kind==="human"?opponentName():names[kind];
  $("mode-label").textContent=analysis?"Analysis":editor?"Position editor":`${setup?"New game":"Play"}${opponent==="frontier"?` · humanity ${prefs.humanity}`:""}`;
  $("size-label").textContent=`Size ${side}`;
  document.querySelector("main").dataset.mode=mode;
  $("editor").hidden=!editor;$("search-panel").hidden=editor||setup&&!task;$("analysis-panel").hidden=!analysis||sideTab!=="move";
  $("view-modes").hidden=!analysis;$("ownership-legend").hidden=!analysis||boardView!=="ownership";
  $("margin-legend").hidden=!analysis||boardView!=="margin";$("difference-legend").hidden=!analysis||boardView!=="difference";$("history-panel").hidden=setup||editor;
  for(const button of document.querySelectorAll("[data-view]")){button.setAttribute("aria-pressed",button.dataset.view===boardView);button.classList.toggle("selected",button.dataset.view===boardView);}
  const explained=explanations.get(cursor),canExplain=analysis&&cursor<moves.length&&[6,8].includes(side)&&!board._hn_score(2);
  $("explain-panel").hidden=!analysis||sideTab!=="move";$("explain").disabled=!canExplain||!!explaining||loadingBoard;
  $("side-tabs").hidden=!analysis;$("game-panel").hidden=!analysis||sideTab!=="game";
  for(const button of document.querySelectorAll("[data-tab]")){button.setAttribute("aria-pressed",button.dataset.tab===sideTab);button.classList.toggle("selected",button.dataset.tab===sideTab);}
  const canReview=analysis&&[6,8].includes(side)&&initial.kind==="normal"&&moves.length>=10;
  $("write-commentary").disabled=!reviewRun&&(!canReview||!!explaining||loadingBoard);
  $("write-commentary").textContent=reviewRun?"Stop commentary":"Write commentary";
  $("review-game").hidden=true; // The single commentary action stays in the analysis toolbar.
  $("review-game").disabled=!reviewRun&&(!canReview||!!explaining||loadingBoard);$("review-game").textContent=reviewRun?"Stop commentary":shownReview&&shownParts?"Continue commentary":shownReview?"Rewrite commentary":"Write commentary";
  $("review-status").textContent=reviewRun?`${reviewRun.phase}…`:shownReview&&shownParts?"Stopped before the end; what was found is kept.":shownReview?"":canReview?"The story of the game, what stands out, and the moves that mattered. Takes a few minutes in a browser.":
    !analysis?"":![6,8].includes(side)?"Reviews are available on boards 6 and 8.":initial.kind!=="normal"?"Reviews need a game from the usual start.":"Play or load at least ten moves.";
  $("review-progress").hidden=!reviewRun;
  if(reviewRun){const share=Math.min(100,100*reviewRun.done/Math.max(1,reviewRun.total));$("review-fill").style.width=`${share}%`;$("review-progress").setAttribute("aria-valuenow",Math.round(share));}
  const gameSignature=shownReview&&analysis?`${shownSerial}:${cursor}`:"";
  if($("game-text").dataset.signature!==gameSignature){
    if(gameSignature)Review.view.render($("game-text"),shownReview,openMove,cursor<moves.length?cursor+1+numberOffset():null,shownParts);else $("game-text").replaceChildren();
    $("game-text").dataset.signature=gameSignature;
  }
  $("explain").textContent=canExplain?`Explain ${moves[cursor]<0?"the pass":cname(moves[cursor])}`:"Explain move";
  $("explain-status").textContent=explaining?`${explaining.phase}…`:canExplain?(explained?"":"What the move played here does, and what the engine's move would do better."):
    !analysis?"":![6,8].includes(side)?"Explanations are available on boards 6 and 8.":"Go back to a move of the game to have it explained.";
  $("explain-progress").hidden=!explaining;
  if(explaining){const share=Math.min(100,100*explaining.done/Math.max(1,explaining.total));$("explain-fill").style.width=`${share}%`;$("explain-progress").setAttribute("aria-valuenow",Math.round(share));}
  // The text is built again only when it changes: a button replaced between press and release would lose its click
  // while a search keeps the page rendering.
  const text=$("explain-text"),stepKey=linePreview?.index===cursor?`${linePreview.line}:${linePreview.k}`:"";
  const signature=explained&&!explaining?JSON.stringify([cursor,explained.kind,explained.lines,stepKey]):"";
  if(text.dataset.signature!==signature)text.replaceChildren();
  if(explained&&!explaining&&text.dataset.signature!==signature){
    text.className=`explanation ${explained.kind}`;
    explained.lines.forEach((line,k)=>{
      const p=document.createElement("p");
      if(!k&&Review.words.MARKS[explained.kind]){const mark=document.createElement("span");mark.className="explain-mark";mark.textContent=Review.words.MARKS[explained.kind];p.append(mark);}
      p.append(line);text.append(p);
    });
    if(explained.steps){
      const box=document.createElement("div"),cap=document.createElement("p");box.className="explain-lines";
      cap.textContent="Play it out: click a move to see the board after it.";box.append(cap);
      explained.steps.forEach((steps,line)=>{
        const single=explained.steps.length===1,better=single||line;      // a praised move has one line, its own
        const row=document.createElement("div"),tag=document.createElement("span");row.className=`explain-line ${better?"better":"played"}`;
        tag.textContent=single?"line:":line?"better:":"played:";row.append(tag);
        steps.forEach((step,k)=>{
          const button=document.createElement("button");button.type="button";button.textContent=step.move;button.className=step.by===1?"r":"w";
          button.setAttribute("aria-pressed",String(linePreview?.index===cursor&&linePreview.line===line&&k<=linePreview.k));
          button.addEventListener("click",()=>{linePreview={index:cursor,line,k};render();});row.append(button);
        });
        box.append(row);
      });
      if(stepKey){
        const back=document.createElement("button");back.type="button";back.textContent="Back to the position";
        back.addEventListener("click",()=>{linePreview=null;render();});box.append(back);
      }
      text.append(box);
    }
    if(explained.details?.length){
      // true and checked like the main text, but not the reason itself: alternatives, the engine's lines, where the points go
      const more=document.createElement("details"),summary=document.createElement("summary");
      more.className="explain-more";more.open=!!explained.open;summary.textContent="More about this move";more.append(summary);
      for(const line of explained.details){const p=document.createElement("p");p.append(line);more.append(p);}
      more.addEventListener("toggle",()=>{explained.open=more.open;});
      text.append(more);
    }
  }
  text.dataset.signature=signature;
  $("analyze-game").hidden=!analysis;$("analyze-game").disabled=!board||loadingBoard||!!reviewRun;
  $("analyze-game").textContent=gameAnalysis?"Stop analysis":"Analyze game";$("analyze-game").setAttribute("aria-pressed",!!gameAnalysis);
  $("game-analysis-status").textContent=gameAnalysis?`Analyzing position ${cursor} · ${gameAnalysis.done} of ${gameAnalysis.end+1} complete`:analysisMessage;
  $("setup-actions").hidden=!setup;$("computer-setup").hidden=!!handicap||stage!=="placing";
  $("computer-setup").textContent=`Let ${opponentName()} set up`;
  $("undo-setup").hidden=stage==="choose"||stage==="evaluating"||stage==="white-search";$("undo-setup").disabled=!placements.length;
  $("finish-setup").hidden=!["offer-ready","white-ready"].includes(stage)||!setup;
  $("finish-setup").textContent=handicap?"Start challenge":"Offer position";
  $("choose-colour").hidden=stage!=="choose"||!setup;
  $("search").disabled=!!task||setup||editor||mode==="play"&&board._hn_stm()===humanSide;
  $("stop").disabled=!task&&!gameAnalysis;$("pass").hidden=setup||editor||!!board._hn_score(2)||!!board._hn_can_move()||mode==="play"&&board._hn_stm()!==humanSide;
  $("back").disabled=setup||editor||cursor===0;$("forward").disabled=setup||editor||cursor===moves.length;
  $("timeline").disabled=setup||editor;$("timeline").max=moves.length;$("timeline").value=cursor;
  $("move-number").textContent=cursor?`Move ${cursor+numberOffset()} of ${moves.length+numberOffset()}`:"Initial position";
  $("turn").textContent=playFinished&&mode==="play"&&cursor===moves.length?playFinished.resigned?"You resigned":playFinished.won?"You won":`${opponentName()} won`:editor?"Edit the board":setup?
    stage==="placing"?handicap?`Place Red stack ${placements.length+1} of ${handicap}`:`Place the ${placements.length?"White":"Red"} starting stack`:
    stage==="choose"?"Choose your colour":stage==="offer-ready"?`Offer this position to ${opponentName()}`:stage==="white-ready"?"Red is ready":stage==="white-search"?`${opponentName()} is placing White…`:stage==="offering"?`${opponentName()} is setting up…`:`${opponentName()} is choosing a colour…`:
    board._hn_score(2)?`Final score: Red ${board._hn_score(0)} · White ${board._hn_score(1)}`:
    `${board._hn_stm()===1?"Red":"White"} to move${mode==="play"?board._hn_stm()===humanSide?" · your turn":` · ${opponentName()}`:""}`;
  $("board-note").textContent=editor?"Choose a stack, then click a cell.":setup&&stage==="choose"?"Play a legal move to choose Red, or use the colour buttons.":mode==="play"&&cursor<moves.length?"Reviewing the game. Choose Play above to continue.":"";
  const score=board._hn_score(2)?board._hn_score(0)-board._hn_score(1):result?.redMargin??marginHistory.get(cursor);
  $("score").textContent=analysis?`Expected margin: Red ${signed(score)} cells`:"";
  $("search-stats").textContent=result?.offerStage&&task?.purpose==="offer"?`Evaluating JesseJames as ${result.offerStage==="red"?"Red":"White"}`:
    result?(result.capacityReached?"Memory limit":""):
    task?workerReady?task.purpose==="offer"&&kind==="jesse"?"Evaluating both colours…":"Thinking…":"Loading engine…":"";
  $("search-stats").hidden=!$("search-stats").textContent;
  const rate=result?.simulations>0&&result.ms>0?result.simulations*1000/result.ms:!result?measuredSpeed:null;
  $("search-speed").textContent=(rate!==null?`${rate.toFixed(1)} sims/s`:result?.engineStatus==="human_policy"?"Policy only":result&&result.simulations===0&&result.visits>0?"Reused search":"— sims/s");
  $("search-speed").title="New simulations divided by elapsed search time. Reused visits and model loading are excluded.";
  const measured=result?.inference?result:lastInference,perf=measured?.inference;
  $("search-profile").hidden=url.searchParams.get("profile")!=="1"||!perf;
  $("search-profile").textContent=perf?`Inference: ${(perf.ms/1000).toFixed(2)} s of ${(measured.ms/1000).toFixed(2)} s · ${perf.calls} calls · ${(perf.rows/Math.max(1,perf.calls)).toFixed(1)} rows/call · largest batch ${Math.max(0,...Object.keys(perf.batches).map(Number))}${perf.failed?` · ${perf.failed} failed calls`:""}${engineBackend==="webgpu"&&gpuHalfPrecision!==null?` · FP16 ${gpuHalfPrecision?"available":"unavailable"}`:""} · ${scanImplementation} scan`:"";
  $("search-profile").title="Wall time inside network evaluation, including data transfer. Rows include batch padding; loading and verification are excluded.";
  $("search-progress").hidden=!(task||result)||!progress.target;
  $("progress-fill").style.width=`${Math.min(100,100*progress.visits/Math.max(1,progress.target))}%`;
  const track=$("search-progress").querySelector('[role="progressbar"]');track.setAttribute("aria-valuemax",progress.target||1);track.setAttribute("aria-valuenow",Math.min(progress.visits,progress.target));
  if(document.activeElement!==$("moves"))$("moves").value=editor?P.serialize(P.snapshot(board)):setup?"":P.serialize(initial,moves);
  $("candidates").replaceChildren();
  $("candidate-side").textContent=board._hn_stm()===1?"Red to move":"White to move";
  $("visits-heading").textContent=result?.policyOnly?"Prior":"Visits";
  const shown=displayedCandidates(),total=shown.reduce((s,c)=>s+(result.policyOnly?c.prior:c.visits),0);
  if(analysis&&result)for(const c of shown){
    const row=document.createElement("tr");row.dataset.move=c.move;row.tabIndex=0;
    row.classList.toggle("played-row",c.move===moves[cursor]);row.classList.toggle("recommended-row",c.move===result.best);
    const share=(result.policyOnly?c.prior:c.visits)/Math.max(Number.EPSILON,total);
    for(const text of [cname(c.move),result.policyOnly?c.prior.toFixed(3):c.visits.toLocaleString()]){const td=document.createElement("td");td.textContent=text;row.append(td);}
    const bar=document.createElement("td");bar.className="share-cell";const fill=document.createElement("span");fill.style.width=`${100*share}%`;bar.append(fill);row.append(bar);
    const margin=document.createElement("td");margin.textContent=c.visits?signed(c.margin):"—";row.append(margin);
    row.onmouseenter=()=>{if(boardView==="difference")return;hover=c.move;$("variation").textContent=(c.pv||[]).map(cname).join(" ");drawBoard();};
    row.onmouseleave=()=>{if(boardView==="difference")return;hover=pinnedCandidate;drawBoard();};
    row.onfocus=row.onmouseenter;row.onblur=row.onmouseleave;
    row.onclick=()=>{pinnedCandidate=c.move;hover=c.move;boardView="difference";$("variation").textContent=(c.pv||[]).map(cname).join(" ");drawBoard();
      for(const b of document.querySelectorAll("[data-view]")){b.setAttribute("aria-pressed",b.dataset.view===boardView);b.classList.toggle("selected",b.dataset.view===boardView);}
      $("difference-legend").hidden=false;$("ownership-legend").hidden=true;$("margin-legend").hidden=true;
    };
    const action=document.createElement("td"),play=document.createElement("button");play.textContent="Play";
    play.setAttribute("aria-label",`Play ${cname(c.move)} in analysis`);
    play.onclick=event=>{event.stopPropagation();try{applyMove(c.move);}catch(error){fail(error);}};
    action.append(play);row.append(action);
    row.onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();row.click();}};
    $("candidates").append(row);
  }
  if(!analysis)$("variation").textContent="";
  drawBoard();drawGraph();renderExperience();persistPlay();
}

$("board").onclick=e=>{const cell=e.target.closest("[data-cell]");if(cell)chooseCell(Number(cell.dataset.cell));};
$("clear-preview").onclick=()=>{pinnedCandidate=null;hover=null;drawBoard();};
$("board").addEventListener("focusin",e=>{
  const cell=e.target.closest("[data-cell]");
  if(cell){focusedCell=Number(cell.dataset.cell);for(const other of $("board").querySelectorAll("[data-cell]"))other.tabIndex=other===cell?0:-1;}
  updateBoardFocus();
});
$("board").addEventListener("focusout",()=>{$("board-focus")?.setAttribute("visibility","hidden");});
$("board").onkeydown=e=>{const current=Number(e.target.closest("[data-cell]")?.dataset.cell);if(!Number.isInteger(current))return;
  if(e.key===" "&&mode==="analysis")return; // Space plays the top analysis move; Enter plays this cell.
  if(["Enter"," "].includes(e.key)){e.preventDefault();chooseCell(current);return;}
  const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-P.grid(side),ArrowDown:P.grid(side)}[e.key];
  if(delta){e.preventDefault();const next=current+delta;if(P.valid(side,next)){focusedCell=next;drawBoard();$("board").querySelector(`[data-cell="${next}"]`)?.focus();}}
};
$("new-game").onclick=()=>{
  for(const[name,value]of Object.entries({opponent:prefs.opponent,opening:prefs.opening,size:prefs.side}))
    document.querySelector(`input[name="${name}"][value="${value}"]`).checked=true;
  updateNewOptions();$("new-dialog").showModal();
};
$("new-form").onsubmit=async e=>{e.preventDefault();const selection=Object.fromEntries(new FormData(e.target));$("new-dialog").close();try{await newGame(selection);showWorkspace();}catch(err){fail(err);}};
document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$("computer-setup").onclick=setupByComputer;
$("undo-setup").onclick=()=>{cancelSearch();placements.pop();stage="placing";updateSetupBoard();};
$("finish-setup").onclick=()=>{if(handicap){stage="white-search";search("placement");}else{stage="evaluating";search("offer");}render();};
$("pick-red").onclick=()=>beginPlay(1);$("pick-white").onclick=()=>beginPlay(2);
$("edit-position").onclick=enterEditor;
$("editor-play").onclick=()=>commitEditor(false);$("editor-analyze").onclick=()=>commitEditor(true);$("editor-cancel").onclick=()=>cancelEditor().catch(fail);
$("editor-undo").onclick=()=>{if(editUndo.length){P.initialize(board,editUndo.pop());$("editor-turn").value=board._hn_stm();render();}};
$("editor-clear").onclick=()=>{editUndo.push(P.snapshot(board));P.initialize(board,P.blank(side,false));$("editor-turn").value=1;render();};
$("editor-centre").onclick=()=>{editUndo.push(P.snapshot(board));board._hn_set_stack(P.centre(side),3,2);render();};
$("editor-turn").onchange=()=>{editUndo.push(P.snapshot(board));board._hn_set_turn(Number($("editor-turn").value));render();};
document.querySelectorAll('input[name="brush"]').forEach(input=>input.onchange=()=>{const owner=Number(input.value);$("stack-height").disabled=owner===0||owner===3;if(owner===3)$("stack-height").value=2;});
$("search").onclick=()=>search(mode==="analysis"?"analysis":"play");
$("stop").onclick=()=>{
  const preview=ownershipRequest;cancelSearch();
  // Stop can discard a queued search or interrupt its connection before its
  // root is evaluated. Finish only the map needed by the displayed position.
  if(mode==="analysis"&&workerReady&&preview?.key===ownershipKey()){
    const request={...preview.request,gen:generation,sims:1,fullBudget:true};
    ownershipRequest={gen:request.gen,key:preview.key,request};worker.postMessage(request);
  }
  if(stage==="white-search")stage="white-ready";if(stage==="evaluating")stage="offer-ready";render();
};
$("pass").onclick=()=>{try{applyMove(-1);}catch(e){fail(e);}};
$("back").onclick=()=>review(cursor-1);$("forward").onclick=()=>review(cursor+1);$("timeline").onchange=()=>review(Number($("timeline").value));
document.querySelectorAll("[data-view]").forEach(button=>button.onclick=()=>{boardView=button.dataset.view;hover=boardView==="difference"?pinnedCandidate:null;render();});
$("analyze-game").onclick=toggleGameAnalysis;
$("explain").onclick=()=>{explainMove();};
$("review-game").onclick=()=>{runReview();};
document.querySelectorAll("[data-tab]").forEach(button=>button.onclick=()=>{sideTab=button.dataset.tab;render();});
let graphPress=null,graphMarks=[],graphSize="";
// A press on a mark opens the position before that move with the two moves compared.
function graphMark(e){
  const frame=graphFrame();
  return graphMarks.find(m=>Math.hypot(m.x-(e.clientX-frame.x),m.y-(e.clientY-frame.y))<13);
}
const graphIndex=x=>{const f=graphFrame();return Math.round(Math.max(0,Math.min(1,(x-f.x-f.left)/(f.right-f.left)))*moves.length);};
new ResizeObserver(()=>{const f=graphFrame();if(board&&`${f.W} ${f.H}`!==graphSize)drawGraph();}).observe($("margin-graph"));
$("margin-graph").onpointerdown=e=>{if(mode==="analysis"||mode==="play")graphPress={id:e.pointerId,x:e.clientX,y:e.clientY};};
$("margin-graph").onpointercancel=()=>graphPress=null;
$("margin-graph").onpointerup=e=>{const press=graphPress;graphPress=null;if(press?.id!==e.pointerId||Math.abs(e.clientY-press.y)>=20)return;
  const mark=mode==="analysis"?graphMark(e):null;
  if(mark){review(mark.index);sideTab="move";if(!explanations.has(mark.index))explainMove();else{if(explanations.get(mark.index).sheet?.lines)boardView="difference";render();}}
  else review(graphIndex(e.clientX));};
$("margin-graph").onkeydown=e=>{const next={ArrowLeft:cursor-1,ArrowRight:cursor+1,Home:0,End:moves.length}[e.key];if(next!==undefined){e.preventDefault();review(next);}};
$("copy").onclick=async()=>{try{const text=mode==="editor"?P.serialize(P.snapshot(board)):P.serialize(initial,moves);$("moves").value=text;await navigator.clipboard.writeText(text);$("board-note").textContent="Moves copied.";}catch{$("moves").select();$("board-note").textContent="Select and copy the move text.";}};
async function loadText(text,recordSide=side){
  clearError();const parsed=P.parse(text,recordSide),old={initial,moves,cursor,mode,stage,side,snapshot:P.snapshot(board)};
  if(![6,8].includes(parsed.position.side))throw new Error("HighNoon analysis is available on boards 6 and 8.");
  if(mode==="play"||mode==="setup")savedPlay=stoppedPlaySnapshot();
  cancelSearch();if(parsed.position.side!==side)await loadBoard(parsed.position.side);
  // A record often goes on after the result is settled (filling in, passes): it is loaded up to there.
  let kept=0;
  try{
    P.initialize(board,parsed.position);
    for(;kept<parsed.moves.length&&!board._hn_score(2);kept++)P.play(board,parsed.moves[kept],true);
  }catch(e){if(old.side!==side)await loadBoard(old.side);P.initialize(board,old.snapshot);render();throw e;}
  const beyond=parsed.moves.length-kept;parsed.moves=parsed.moves.slice(0,kept);
  if(old.mode==="editor"){
    if(old.side===side)editUndo.push(old.snapshot);else editUndo=[];
    initial=P.snapshot(board);moves=[];cursor=0;placements=[];handicap=0;
    $("editor-turn").value=board._hn_stm();result=null;hover=null;clearAnalysis();render();return;
  }
  initial=parsed.position;moves=parsed.moves;cursor=moves.length;mode="analysis";stage="done";humanSide ||=1;
  result=null;hover=null;clearAnalysis();
  if(beyond)analysisMessage=`The result is settled after move ${kept+numberOffset()}; the record's last ${beyond} ${beyond===1?"move is":"moves are"} left out.`;
  render();search("analysis");
}
$("load").onclick=()=>{
  const text=$("moves").value;let saved=null;
  if(text.trim().startsWith("{")){try{saved=JSON.parse(text);}catch{}}      // a saved review; a custom position also starts with a brace
  (saved?.timeline?loadReview(saved):loadText(text,Number($("record-size").value))).catch(fail);
};
$("settings").onclick=()=>{
  $("humanity").value=prefs.humanity;$("humanity-value").value=prefs.humanity;
  $("tumbstone-sims").value=prefs.tumbstoneSims;$("jesse-sims").value=prefs.jesseSims;$("sound").checked=prefs.sound;
  $("settings-dialog").showModal();
};
$("humanity").oninput=()=>$("humanity-value").value=Number($("humanity").value).toFixed(2);
$("settings-form").onsubmit=e=>{e.preventDefault();prefs.tumbstoneSims=Number($("tumbstone-sims").value);prefs.jesseSims=256;prefs.sound=$("sound").checked;savePrefs();$("settings-dialog").close();cancelSearch();render();if(mode==="analysis")search("analysis");else maybeComputer();};
document.addEventListener("keydown",e=>{
  if(e.defaultPrevented||e.isComposing||e.keyCode===229||e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||
    document.querySelector("dialog[open]")||e.target.isContentEditable||
    e.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
  if(e.key===" "&&mode==="analysis"){
    e.preventDefault(); // Do not scroll or activate a focused display button, including on repeats.
    e.target.closest?.("[data-view]")?.blur();
    if(e.repeat||!board||loadingBoard||board._hn_score(2)||!result)return;
    const top=$("candidates").querySelector("tr[data-move]");
    if(top)chooseCell(Number(top.dataset.move));
    return;
  }
  if(e.target.closest?.("#board,#margin-graph"))return;
  if(e.key==="ArrowLeft"){e.preventDefault();review(cursor-1);}
  if(e.key==="ArrowRight"){e.preventDefault();review(cursor+1);}
});
window.addEventListener("pagehide",()=>{cancelSearch();disposeWorker();});
window.Unified={loadReview,runReview,reviewSearch:(jobs,visits,pvLength=10)=>reviewCall({type:"review-search",jobs,visits,pvLength}),shownReview:()=>shownReview,shownParts:()=>shownParts&&[...shownParts],reviewRun:()=>reviewRun&&{...reviewRun},explain:explainMove,explanations:()=>new Map(explanations),explaining:()=>explaining&&{...explaining},difference:moveDifference,marks:()=>graphMarks.map(m=>({...m})),state:()=>({side,opponent,mode,stage,initial:structuredClone(initial),moves:[...moves],cursor,humanSide,task,result,prefs:{...prefs},boardView,engineBackend,gameAnalysis,analysisRecords:[...analysisRecords]}),loadText,search,chooseCell,review};
initializeExperience().catch(fail);

// Play and Analyze share the board, but exploring a variation never changes the saved game.
function playSnapshot(){
  return {side,opponent,profile:prefs.profile,initial:structuredClone(initial),moves:[...moves],cursor,
    mode,stage,placements:[...placements],handicap,humanSide,challenge:structuredClone(challenge),playFinished};
}
function stoppedPlaySnapshot(){
  const snapshot=playSnapshot();
  if(snapshot.mode==="play")snapshot.cursor=snapshot.moves.length;
  return snapshot;
}
function persistPlay(){
  const snapshot=mode==="analysis"||mode==="editor"?savedPlay:playSnapshot();
  if(!snapshot)return;
  try{localStorage.setItem("highnoon-game-v1",JSON.stringify(snapshot));}catch{}
}
async function restorePlay(snapshot){
  cancelSearch();
  if(![6,8].includes(snapshot.side)||!opponents.includes(snapshot.opponent))throw new Error("This saved game is unavailable.");
  if(snapshot.opponent==="human"&&!humanProfiles.some(p=>p.key===snapshot.profile))throw new Error("This opponent is no longer available.");
  await loadBoard(snapshot.side);
  ({opponent,initial,moves,cursor,mode,stage,placements,handicap,humanSide,challenge,playFinished}=snapshot);
  // A saved position cannot restore an in-flight response or its pacing timer.
  if(mode==="setup")stage=({offering:"placing",evaluating:"offer-ready","white-search":"white-ready"})[stage]||stage;
  prefs.profile=snapshot.profile;prefs.side=side;prefs.opponent=opponent;
  P.replay(board,initial,moves,cursor);result=null;hover=null;savedPlay=null;clearAnalysis();render();maybeComputer();
}
function matchesSavedPosition(snapshot){
  if(snapshot.side!==side)return false;
  const current=P.snapshot(board);
  try{
    P.replay(board,snapshot.initial,snapshot.moves,snapshot.cursor);
    return JSON.stringify(P.snapshot(board))===JSON.stringify(current);
  }finally{
    if(mode==="editor")P.initialize(board,current);
    else P.replay(board,initial,moves,cursor);
  }
}
function continueCurrentPosition(reference){
  cancelSearch();clearError();
  if(reference){opponent=reference.opponent;prefs.profile=reference.profile;humanSide=reference.humanSide;}
  if(side!==8&&opponent!=="highnoon")opponent="highnoon";
  prefs.side=side;prefs.opponent=opponent;savePrefs();
  if(mode==="editor"){commitEditor(false);return;}
  savedPlay=null;moves=moves.slice(0,cursor);trimAnalysis(cursor+1);humanSide ||=1;
  mode="play";stage="done";challenge=null;playFinished=null;result=null;hover=null;
  render();maybeComputer();
}
async function requestPlay(){
  if(!board||loadingBoard||mode==="setup")return;
  if(mode==="play"&&cursor===moves.length){if(!task)maybeComputer();return;}
  const previous=savedPlay||(mode==="play"?stoppedPlaySnapshot():null);
  if(!previous){continueCurrentPosition(null);return;}
  if(matchesSavedPosition(previous)){await restorePlay(structuredClone(previous));return;}
  cancelSearch();render();playChoice=structuredClone(previous);
  const describe=(position,index)=>`Size ${position.side} · ${index?`After move ${index+(position.kind==="normal"?2:0)}`:"Starting position"}`;
  $("continue-saved-label").textContent=previous.mode==="setup"?"Return to setup":"Resume saved game";
  $("continue-saved-detail").textContent=previous.mode==="setup"?`Size ${previous.side} · Your opening setup`:describe(previous.initial,previous.cursor);
  $("continue-current-detail").textContent=(mode==="editor"?`Size ${side} · Edited position`:describe(initial,cursor))+
    (previous.challenge?" · Practice; handicap unchanged":"")+
    (side!==8&&previous.opponent!=="highnoon"?" · Against HighNoon":"");
  $("continue-dialog").showModal();
}
function finishPlay(won,resigned=false){
  if(playFinished)return;
  playFinished={won,resigned,...(resigned?{}:{red:board._hn_score(0),white:board._hn_score(1)})};
  if(!challenge||challenge.completed)return;
  try{Object.assign(challengeProgress,JSON.parse(localStorage.getItem("highnoon-challenge-v1")||"{}"));}catch{}
  if(!challengeProgress.completed.includes(challenge.id)){
    challengeProgress.handicap=Math.max(1,Math.min(167,challenge.handicap+(won?-1:1)));
    challengeProgress[won?"wins":"losses"]++;
    challengeProgress.completed.push(challenge.id);
    try{localStorage.setItem("highnoon-challenge-v1",JSON.stringify(challengeProgress));}catch{}
  }
  playFinished.nextHandicap=challengeProgress.handicap;
  challenge.completed=true;
}
function renderExperience(){
  $("welcome").hidden=!welcomeOpen;
  document.querySelector("main").hidden=welcomeOpen;
  document.querySelector(".mode-switch").hidden=welcomeOpen;
  $("welcome-continue").hidden=mode==="setup"&&!savedPlay||!board;
  const analysis=mode==="analysis"||mode==="editor";
  $("record-size-label").hidden=!analysis;
  if($("record-size").dataset.side!==String(side)){$("record-size").value=side;$("record-size").dataset.side=side;}
  $("mode-play").setAttribute("aria-pressed",String(!analysis));
  $("mode-analyze").setAttribute("aria-pressed",String(analysis));
  $("play-panel").hidden=analysis||!!playFinished;
  $("play-title").textContent=opponent==="jesse"?(challenge?"The JesseJames challenge":"Play JesseJames"):opponent==="human"?`Play ${opponentName()}`:"Play HighNoon";
  $("play-description").textContent=opponent==="jesse"
    ?challenge?`You play Red with ${handicap} starting stacks. JesseJames places White, then the game begins.`:"Practice from this position against JesseJames. This game will not change your handicap."
    :opponent==="human"?"A human style, familiar openings, and a new game every time. Set up an opening or let your opponent offer one."
    :`HighNoon plays with ${side===6?"mc014":"mc014s8"}. Offer an opening, or let HighNoon set up and choose your colour.`;
  $("challenge-info").hidden=opponent!=="jesse"||!challenge;
  $("challenge-handicap").textContent=handicap;
  $("challenge-record").textContent=`${challengeProgress.wins} wins · ${challengeProgress.losses} losses`;
  const finished=mode==="play"&&!!playFinished&&cursor===moves.length;
  $("play-result").hidden=!finished;
  if(finished){
    const winner=playFinished.won?"You":opponentName();
    const margin=Math.abs(playFinished.red-playFinished.white);
    $("result-text").textContent=playFinished.resigned?`${winner} won by resignation.`:`${winner} won by ${margin} ${margin===1?"cell":"cells"}.`;
    $("result-score").textContent=(playFinished.resigned?"":`Final score: Red ${playFinished.red} · White ${playFinished.white}. `)+`You played ${humanSide===1?"Red":"White"}.`;
    $("result-next").hidden=!challenge;
    if(challenge){
      const next=playFinished.nextHandicap??challengeProgress.handicap;
      $("result-next").textContent=`Next challenge: ${next} Red starting ${next===1?"stack":"stacks"}.`;
    }
  }
  $("resign").hidden=mode!=="play"||!!playFinished||cursor!==moves.length;
  $("pass").hidden ||=!!playFinished;
  $("edit-position").hidden=!analysis;
  $("search-panel").hidden=!analysis&&!task;
  $("write-commentary").hidden=!analysis;
  $("search").hidden=!analysis;
  $("search-speed").hidden=!analysis;
  if(mode==="play"&&!playFinished&&cursor===moves.length&&board._hn_stm()!==humanSide&&!task&&!board._hn_score(2)){
    $("board-note").textContent="Choose Play above to continue the game.";
  }
}
function updateNewOptions(){
  const kind=document.querySelector('input[name="opponent"]:checked').value;
  $("human-options").hidden=kind!=="human";
  $("challenge-options").hidden=kind!=="jesse";
  $("highnoon-options").hidden=kind!=="highnoon";
  $("new-handicap").textContent=challengeProgress.handicap;
  for(const input of document.querySelectorAll('input[name="size"]'))input.disabled=kind!=="highnoon"&&input.value!=="8";
  if(kind!=="highnoon")document.querySelector('input[name="size"][value="8"]').checked=true;
  $("new-submit").textContent=kind==="jesse"?"Set up the challenge":"Start a game";
}
async function initializeExperience(){
  try{
    const configuration=await fetch("human-runtime.json");
    const runtime=configuration.ok?await configuration.json():{backend:"local"};
    if(runtime.backend==="browser"){
      const response=await fetch("human.json");
      if(!response.ok)throw new Error("Human opponents unavailable");
      browserHuman=new HumanPolicy.Policy(await response.json());
      humanProfiles=browserHuman.data.profiles;
    }else{
      const response=await fetch("/api/profiles");
      if(!response.ok)throw new Error("Human opponents unavailable");
      humanProfiles=await response.json();
    }
  }catch{
    humanAvailable=false;
    const response=await fetch("players.json");
    const permitted=response.ok?await response.json():[];
    humanProfiles=[...Array.from({length:13},(_,i)=>({key:i===12?"elo:good-day":`elo:${1000+100*i}`,name:`Level ${i+1}`,generic:true})),...permitted];
    document.querySelector('input[name="opponent"][value="human"]').disabled=true;
    prefs.opponent="highnoon";
  }
  if(!humanProfiles.some(p=>p.key===prefs.profile))prefs.profile=defaults.profile;
  const picker=$("human-profile");
  for(const [label,generic] of [["Choose a level",true],["Player styles",false]]){
    const group=document.createElement("optgroup");group.label=label;
    for(const p of humanProfiles.filter(p=>!!p.generic===generic)){
      const option=document.createElement("option");option.value=p.key;option.textContent=p.name;group.append(option);
    }
    picker.append(group);
  }
  picker.value=prefs.profile;
  const showProfile=()=>{
    const p=humanProfiles.find(p=>p.key===picker.value);
    for(const id of ["profile-avatar","human-card-avatar"])$(id).src=p?.avatar||"avatars/unknown.jpg";
    $("profile-name").textContent=p?.name||"Human imitation";
    $("profile-description").textContent=p?.generic?"Choose from thirteen levels of human play.":"An imitation of their play, shared with their permission.";
  };
  picker.onchange=showProfile;showProfile();
  document.querySelectorAll('input[name="opponent"]').forEach(input=>input.onchange=updateNewOptions);
  $("mode-analyze").onclick=enterAnalysis;
  $("welcome-new").onclick=()=>$("new-game").click();
  $("welcome-analyze").onclick=()=>{showWorkspace();enterAnalysis();};
  $("welcome-continue").onclick=()=>{showWorkspace();if(savedPlay)restorePlay(structuredClone(savedPlay)).catch(fail);else maybeComputer();};
  $("home-link").onclick=event=>{event.preventDefault();cancelSearch();welcomeOpen=true;render();};
  $("mode-play").onclick=()=>requestPlay().catch(fail);
  $("continue-saved").onclick=()=>{
    const previous=playChoice;playChoice=null;$("continue-dialog").close();
    if(previous)restorePlay(previous).catch(fail);
  };
  $("continue-current").onclick=()=>{
    const previous=playChoice;playChoice=null;$("continue-dialog").close();
    continueCurrentPosition(previous);
  };
  $("continue-dialog").onclose=()=>{
    const cancelled=!!playChoice;playChoice=null;
    if(cancelled&&mode==="analysis"&&!task&&!result)search("analysis");
  };
  $("write-commentary").onclick=()=>{sideTab="game";render();runReview();};
  $("next-game").onclick=()=>newGame({side,opponent,profile:prefs.profile,opening:0}).catch(fail);
  $("resign").onclick=()=>$("resign-dialog").showModal();
  $("confirm-resign").onclick=()=>{$("resign-dialog").close();cancelSearch();finishPlay(false,true);render();};
  let saved;
  try{saved=JSON.parse(localStorage.getItem("highnoon-game-v1")||"null");}catch{}
  if(saved&&saved.opponent==="human"&&!humanAvailable)saved=null;
  if(saved){
    try{await restorePlay(saved);}catch(error){saved=null;fail(error);}
  }
  if(!saved)await newGame({side:prefs.side,opponent:prefs.opponent,opening:prefs.opening});
  const game=url.searchParams.get("game");
  if(game){savedPlay=playSnapshot();showWorkspace();return loadText(game);}
  render();
}

function showWorkspace(){welcomeOpen=false;render();}
