const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
test('actual gutter layout stacks simultaneous composer, chip and tall answer without overlap',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../renderer/renderer.js'),'utf8');
  const code=source.slice(source.indexOf('  function layoutAssignmentOverlays()'),source.indexOf('  let reportedBubbleRect'));
  const element=h=>({style:{},classList:{contains:()=>false},get offsetHeight(){return Math.min(h,parseFloat(this.style.maxHeight)||h);}});
  const quick=element(100),hint=element(70),keep=element(40),bubble=element(900);
  const elements={'#quick-ask':quick,'#knot-hint':hint,'#orb':{getBoundingClientRect:()=>({top:890})}};
  vm.runInNewContext(code+';layoutAssignmentOverlays();',{window:{innerWidth:1760,innerHeight:990},$:id=>elements[id],keepChip:keep,bubble,reportBubbleRect(){},isShown:el=>!!el});
  const ordered=[bubble,keep,hint,quick];
  for(let i=0;i<ordered.length;i++){
    assert.ok(parseFloat(ordered[i].style.left)>=1760*0.7);
    if(i)assert.ok(parseFloat(ordered[i-1].style.top)+ordered[i-1].offsetHeight+12<=parseFloat(ordered[i].style.top));
  }
});
