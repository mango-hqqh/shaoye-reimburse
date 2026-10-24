const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {fileExtension}=require('./attachments.cjs');
const {parseInvoice}=require('../shared/invoices.cjs');
async function readPdf(buffer,forceRender=false){
  const file=path.join(__dirname,'pdf-worker.cjs').replace(/app\.asar([\\/])/g,'app.asar.unpacked$1');
  const worker=new Worker(file);
  try{
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>done(new Error('PDF 读取超时，原文件已保留，可手动关联')),60000);
      worker.on('message',m=>m.error?done(new Error(m.error)):done(null,m.result));
      worker.once('error',done);worker.once('exit',code=>done(new Error('PDF 读取进程退出 '+code)));
      worker.postMessage({buffer,forceRender});
    });
  }finally{await worker.terminate();}
}
async function readInvoice(buffer,ocr,id){
  const extension=fileExtension(buffer),warnings=[];
  let text='',automatic=true;
  try{
    if(extension==='pdf'){
      const pdf=await readPdf(buffer);
      if(pdf.warnings.length){warnings.push(...pdf.warnings);automatic=false;}
      const parts=[];
      for(let index=0;index<pdf.pages.length;index++){
        const page=pdf.pages[index];
        if(page.image){
          const result=await ocr.recognize(Buffer.from(page.image),id);
          parts.push(result.text);
          warnings.push(...(result.warnings||[]));
          if(result.confidence<70)automatic=false;
        }else parts.push(page.text);
      }
      text=parts.join('\n');
    }else{
      const result=await ocr.recognize(buffer,id);text=result.text;
      warnings.push(...(result.warnings||[]));if(result.confidence<70)automatic=false;
    }
  }catch(error){warnings.push('发票识别未完成：'+error.message+'；原文件已保存，请手动关联订单');automatic=false;}
  const parsed=parseInvoice(text.slice(0,100000));
  if(parsed.invoiceNos.length>1)automatic=false;
  parsed.warnings=[...new Set([...parsed.warnings,...warnings])];
  return {parsed,automatic};
}
module.exports={readInvoice,readPdf};
