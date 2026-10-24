const {parentPort}=require('node:worker_threads');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
function orderedText(items){
  const rows=[];
  for(const item of items){
    if(!item.str?.trim()||!item.transform)continue;
    const x=item.transform[4],y=item.transform[5],height=Math.max(5,Math.abs(item.height||item.transform[3]));
    let row=rows.find(r=>Math.abs(r.y-y)<Math.min(r.height,height)*.5);
    if(!row){row={y,height,items:[]};rows.push(row);}
    row.items.push({x,text:item.str});
  }
  return rows.sort((a,b)=>b.y-a.y).map(row=>row.items.sort((a,b)=>a.x-b.x).map(i=>i.text).join(' ')).join('\n');
}
parentPort.once('message',async({buffer,forceRender=false})=>{
  let doc,loading;
  try{
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfRoot=path.dirname(require.resolve('pdfjs-dist/package.json'));
    pdfjs.GlobalWorkerOptions.workerSrc=pathToFileURL(path.join(pdfRoot,'legacy/build/pdf.worker.mjs')).href;
    loading=pdfjs.getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:true,useWorkerFetch:false,
      cMapUrl:pdfRoot.replace(/\\/g,'/')+'/cmaps/',cMapPacked:true,standardFontDataUrl:pdfRoot.replace(/\\/g,'/')+'/standard_fonts/',
      wasmUrl:pdfRoot.replace(/\\/g,'/')+'/wasm/',stopAtErrors:true,enableXfa:false,maxImageSize:16000000});
    doc=await loading.promise;
    const pages=[],warnings=[];
    if(doc.numPages>10)warnings.push('PDF 超过 10 页，仅识别前 10 页；原文件完整保留，请手动关联');
    for(let pageNo=1;pageNo<=Math.min(10,doc.numPages);pageNo++){
      const page=await doc.getPage(pageNo),content=await page.getTextContent();
      const text=orderedText(content.items).slice(0,50000);
      let image=null;
      // Some pages contain a selectable heading over a scanned invoice body.
      // Decide per page, even when another page already has usable text.
      const hasTotal=/(?:小\s*写\s*[）)]?\s*[:：]?\s*[¥￥]?\s*[-+]?\s*\d|价\s*税\s*合\s*计\s*[:：]?\s*[¥￥]?\s*[-+]?\s*\d)/.test(text);
      if(forceRender||text.replace(/\s/g,'').length<40||!hasTotal){
        const natural=page.getViewport({scale:1});
        const scale=Math.min(2.2,2200/Math.max(natural.width,natural.height));
        const viewport=page.getViewport({scale});
        if(!Number.isFinite(viewport.width*viewport.height)||viewport.width<1||viewport.height<1)throw new Error('PDF 页面尺寸无效');
        const canvas=doc.canvasFactory.create(Math.ceil(viewport.width),Math.ceil(viewport.height));
        try{
          await page.render({canvasContext:canvas.context,viewport}).promise;
          image=canvas.canvas.toBuffer('image/png');
        }finally{doc.canvasFactory.destroy(canvas);}
      }
      pages.push({text,image});page.cleanup();
    }
    parentPort.postMessage({result:{pages,warnings}});
  }catch(error){parentPort.postMessage({error:error?.name==='PasswordException'?'发票 PDF 已加密，请先提供无密码文件':error?.message||String(error)});}
  finally{if(loading)await loading.destroy().catch(()=>{});}
});
