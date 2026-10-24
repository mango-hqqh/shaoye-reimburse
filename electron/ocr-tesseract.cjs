const path=require('node:path');
const fs=require('node:fs');
const {createWorker}=require('tesseract.js');
class Ocr {
  constructor(langPath,progress){this.langPath=langPath;this.progress=progress;this.worker=null;this.queue=Promise.resolve();this.activeId='';}
  async recognize(buffer,id){
    const job=this.queue.then(async()=>{
      this.activeId=id;
      for(const lang of ['chi_sim','eng'])if(!fs.existsSync(path.join(this.langPath,lang+'.traineddata.gz')))throw new Error('离线识别语言包缺失，请运行 npm run prepare:ocr');
      try {
        if(!this.worker){
          const workerPath=require.resolve('tesseract.js/src/worker-script/node/index.js').replace('app.asar'+path.sep,'app.asar.unpacked'+path.sep);
          this.worker=await createWorker('chi_sim+eng',1,{langPath:this.langPath,workerPath,gzip:true,cacheMethod:'none',logger:message=>this.progress(this.activeId,message),errorHandler:()=>{}});
          await this.worker.setParameters({tessedit_pageseg_mode:'3',preserve_interword_spaces:'1'});
        }
        let timer;
        const result=await Promise.race([
          this.worker.recognize(buffer,{}, {text:true,blocks:true}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('识别超时，请裁剪图片后重试')),120000);})
        ]).finally(()=>clearTimeout(timer));
        const lines=(result.data.blocks||[]).flatMap(block=>(block.paragraphs||[]).flatMap(paragraph=>paragraph.lines||[])).filter(line=>line.text?.trim()&&line.bbox);
        const rows=[];
        for(const line of lines.sort((a,b)=>a.bbox.y0-b.bbox.y0||a.bbox.x0-b.bbox.x0)){
          const center=(line.bbox.y0+line.bbox.y1)/2,height=line.bbox.y1-line.bbox.y0;
          let row=rows.find(row=>Math.abs(row.center-center)<=Math.max(6,Math.min(row.height,height)*0.5));
          if(!row){row={center,height,lines:[]};rows.push(row);}
          row.lines.push(line);
        }
        const text=rows.length?rows.sort((a,b)=>a.center-b.center).map(row=>row.lines.sort((a,b)=>a.bbox.x0-b.bbox.x0).map(line=>line.text.trim()).join(' ')).join('\n'):result.data.text;
        return {text,confidence:result.data.confidence};
      }catch(error){
        if(this.worker)await this.worker.terminate().catch(()=>{});
        this.worker=null;
        throw error;
      }finally{this.activeId='';}
    });
    this.queue=job.catch(()=>{});
    return job;
  }
  async stop(){if(this.worker)await this.worker.terminate();this.worker=null;}
}
module.exports={Ocr};
