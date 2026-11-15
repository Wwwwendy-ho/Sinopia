/* Sparse-paper fallback: locate ink, search local regions, and verify a consistent transform.
   The normal full-image matcher remains the first choice. Everything stays on the device. */
(() => {
 'use strict';
 const A=window.DrawingCompare.Aligner, raster=A.rasterize, estimate=A.estimate;
 const sources=new WeakMap();
 A.rasterize=function(image,maxSide){const r=raster(image,maxSide);sources.set(r,{source:image.source,rotation:image.rotation,flipH:image.flipH,flipV:image.flipV});return r;};
 function inkBox(r){
  const {w,h}=r;let data=r.data;
  // Three box blurs approximate a broad paper-lighting estimate; thin ruler lines carry little weight.
  for(let pass=0;pass<3;pass++){
   const next=new Float32Array(w*h),integral=new Float64Array((w+1)*(h+1)),rad=Math.max(2,Math.round(Math.max(w,h)*.047));
   for(let y=0;y<h;y++){let sum=0;for(let x=0;x<w;x++){sum+=data[y*w+x];integral[(y+1)*(w+1)+x+1]=integral[y*(w+1)+x+1]+sum;}}
   for(let y=0;y<h;y++)for(let x=0;x<w;x++){let x0=Math.max(0,x-rad),x1=Math.min(w,x+rad+1),y0=Math.max(0,y-rad),y1=Math.min(h,y+rad+1);next[y*w+x]=(integral[y1*(w+1)+x1]-integral[y0*(w+1)+x1]-integral[y1*(w+1)+x0]+integral[y0*(w+1)+x0])/((x1-x0)*(y1-y0));}data=next;
  }
  const scores=new Float64Array(256);let peak=0;
  for(let by=2;by<14;by++)for(let bx=2;bx<14;bx++){let sum=0,n=0;for(let y=Math.floor(by*h/16);y<Math.floor((by+1)*h/16);y++)for(let x=Math.floor(bx*w/16);x<Math.floor((bx+1)*w/16);x++){const d=Math.max(0,data[y*w+x]-r.data[y*w+x]-.035);sum+=d*d;n++;}scores[by*16+bx]=sum/n;peak=Math.max(peak,sum/n);}
  if(peak<.0002)return null;
  let x0=16,y0=16,x1=0,y1=0,cells=0;
  for(let y=2;y<14;y++)for(let x=2;x<14;x++)if(scores[y*16+x]>peak*.12){x0=Math.min(x0,x);x1=Math.max(x1,x+1);y0=Math.min(y0,y);y1=Math.max(y1,y+1);cells++;}
  const box=[x0/16,y0/16,(x1-x0)/16,(y1-y0)/16];
  if(cells<4||box[2]<.15||box[3]<.15||box[2]*box[3]>.48||cells/144>.6)return null;
  return box;
 }
 function oriented(info){const {source,rotation,flipH,flipV}=info,turned=rotation%180!==0,c=document.createElement('canvas');c.width=turned?source.height:source.width;c.height=turned?source.width:source.height;let x=c.getContext('2d');x.translate(c.width/2,c.height/2);x.scale(flipH?-1:1,flipV?-1:1);x.rotate(rotation*Math.PI/180);x.drawImage(source,-source.width/2,-source.height/2);return c;}
 function crop(source,box){let x=Math.max(0,Math.round(box[0]*source.width)),y=Math.max(0,Math.round(box[1]*source.height)),w=Math.min(source.width-x,Math.round(box[2]*source.width)),h=Math.min(source.height-y,Math.round(box[3]*source.height));if(w<16||h<16)return null;let c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(source,x,y,w,h,0,0,w,h);return {r:raster({source:c,rotation:0,flipH:false,flipV:false}),cx:x+w/2-source.width/2,cy:y+h/2-source.height/2,w,h};}
 function lift(m,mov,fix){let c=Math.cos(m.theta),s=Math.sin(m.theta);return {...m,tx:m.tx+fix.cx-m.s*(c*mov.cx-s*mov.cy),ty:m.ty+fix.cy-m.s*(s*mov.cx+c*mov.cy)};}
 function agrees(a,b,size){return Math.abs(Math.log(a.s/b.s))<.06&&Math.abs(a.theta-b.theta)<.045&&Math.hypot(a.tx-b.tx,a.ty-b.ty)<size*.055;}
 A.estimate=async function(moving,fixed,onProgress){
  let cancelled=false;
  const report=p=>{if(onProgress?.(p)===false)cancelled=true;};
  const initial=await estimate(moving,fixed,p=>report(p*.35));
  if(cancelled)return initial;
  const mi=sources.get(moving),fi=sources.get(fixed),box=inkBox(moving);
  if(initial.confident||!mi||!fi||!box){onProgress?.(1);return initial;}
  const msource=oriented(mi),fsource=oriented(fi),mov=crop(msource,box);if(!mov)return initial;
  const candidates=[];let count=0;
  for(const cy of [.25,.5,.75])for(const cx of [.25,.5,.75]){
   if(cancelled)return initial;
   const fix=crop(fsource,[cx-.2,cy-.14,.4,.28]);
   const r=await estimate(mov.r,fix.r);count++;report(.35+.45*count/9);
   if(!r.atEdge&&r.ncc>=.3&&r.psr>=14)candidates.push({match:lift(r,mov,fix),local:r,fix});
  }
  candidates.sort((a,b)=>b.local.ncc-a.local.ncc);let verified=[];
  for(const candidate of candidates.slice(0,3)){
   if(cancelled)return initial;
   if(candidate.local.psr<A.PSR_MIN)continue;
   const r=candidate.local,centerX=candidate.fix.cx+fsource.width/2+r.tx,centerY=candidate.fix.cy+fsource.height/2+r.ty;
   const c=Math.abs(Math.cos(r.theta)),s=Math.abs(Math.sin(r.theta)),w=(mov.w*c+mov.h*s)*r.s,h=(mov.h*c+mov.w*s)*r.s;
   for(const shift of [0,-.04,.04]) {
    if(cancelled)return initial;
    const scale=shift===0?1:.95;
    const fix=crop(fsource,[(centerX-w*scale/2+w*shift)/fsource.width,(centerY-h*scale/2)/fsource.height,w*scale/fsource.width,h*scale/fsource.height]);if(!fix)continue;
    const refined=await estimate(mov.r,fix.r),global=lift(refined,mov,fix);
    if(!refined.atEdge&&refined.ncc>=.43&&refined.psr>=16.5&&agrees(global,candidate.match,Math.max(fsource.width,fsource.height)))verified.push(global);
   }
  }
  onProgress?.(1);
  for(const a of verified)if(verified.some(b=>b!==a&&agrees(a,b,Math.max(fsource.width,fsource.height))))return {...a,confident:true,method:'verified-region'};
  return initial;
 };
})();
