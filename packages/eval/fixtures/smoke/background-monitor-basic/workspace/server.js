let i=0; const timer=setInterval(()=>{ console.log("tick", ++i); if(i>=3){ clearInterval(timer); process.exit(0); } }, 200);
