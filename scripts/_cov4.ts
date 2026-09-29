import { setGrammar } from "../lib/sonic/grammar";
import "../lib/commands/sonic-cli/features";
async function main(){
  const g=await fetch("http://localhost:3000/sonic-cli-grammar.json").then(r=>r.json());
  setGrammar(g);
  const { useLabStore } = await import("../lib/store/lab-store");
  const S=()=>useLabStore.getState();
  S().newLab();
  let n=0;
  const freshSwitch=()=>S().addDevice("switch",{x:(n++%50)*5,y:0});
  const classify=(cmds:{name:string}[], prep?:(sw:string)=>void)=>{
    const b={handled:0,validation:0,unrecognized:0,stub:0,crash:0}; const gaps:string[]=[];
    for(const c of cmds){
      const sw=freshSwitch(); if(prep)prep(sw);
      let t=""; try{ t=S().execCommand(sw,c.name).output.map(o=>o.text).join(" | ").toLowerCase(); }catch(e){b.crash++;gaps.push("CRASH:"+c.name);continue;}
      if(t.includes("unrecognized command")||t.includes("unknown command")){b.unrecognized++;if(gaps.length<40)gaps.push(c.name);}
      else if(t.includes("recognized sonic")||t.includes("not simulated")){b.stub++;}
      else if(t.includes("error")||t.includes("usage")||t.includes("invalid")||t.includes("required")||t.includes("must ")||t.includes("expected")){b.validation++;}
      else b.handled++;
    }
    return {b,gaps};
  };
  const r1=classify(g.views["enable-view"]||[]);
  console.log("=== enable-view (fresh exec per cmd) ===", JSON.stringify(r1.b));
  const r2=classify(g.views["configure-view"]||[], (sw)=>{S().execCommand(sw,"configure terminal");});
  console.log("=== configure-view (fresh per cmd) ===", JSON.stringify(r2.b));
  console.log("\n-- exec still-unrecognized ("+r1.gaps.length+"):"); r1.gaps.slice(0,40).forEach(x=>console.log("  "+x));
  console.log("\n-- config still-unrecognized ("+r2.gaps.length+"):"); r2.gaps.forEach(x=>console.log("  "+x));
}
main();
