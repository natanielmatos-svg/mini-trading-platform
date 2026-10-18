'use strict';
(()=>{
 function visible(card){return !document.hidden&&card.isConnected&&!card.closest('[hidden]');}
 function watch(card,refresh,interval){
  let wasVisible=false,busy=false,last=0;
  async function tick(){
   const shown=visible(card),entered=shown&&!wasVisible;wasVisible=shown;
   if(!shown||busy||(!entered&&Date.now()-last<interval))return;
   busy=true;last=Date.now();try{await refresh();}finally{busy=false;}
  }
  const run=()=>{tick().catch(()=>{});};
  requestAnimationFrame(run);
  const timer=setInterval(run,interval);
  document.addEventListener('desktop:viewchange',run);
  document.addEventListener('visibilitychange',run);
  return ()=>{clearInterval(timer);document.removeEventListener('desktop:viewchange',run);document.removeEventListener('visibilitychange',run);};
 }
 globalThis.PanelPolling={watch,visible};
})();
