const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {EXTENSIONS,ATTACHMENT_ID}=require('./attachments.cjs');
const {DEFAULT_SETTINGS}=require('../shared/domain.cjs');
class Store {
  constructor(folder){
    this.folder=folder; this.file=path.join(folder,'ledger.json'); this.queue=Promise.resolve(); this.recovered=false;
    fs.mkdirSync(path.join(folder,'attachments'),{recursive:true});
    this.data={version:1,records:[],invoices:[],settings:{...DEFAULT_SETTINGS},lastNotification:''};
    const load=file=>{
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if(data.version!==1||!Array.isArray(data.records)||!data.settings||(data.invoices!==undefined&&!Array.isArray(data.invoices)))throw new Error('Unsupported data format');
      return data;
    };
    if(fs.existsSync(this.file)){
      try{this.data=load(this.file);}
      catch(error){
        try{
          this.data=load(this.file+'.bak');
          fs.renameSync(this.file,this.file+'.damaged-'+Date.now());
          fs.writeFileSync(this.file,JSON.stringify(this.data,null,2));
          this.recovered=true;
        }catch{throw new Error('账本文件无法读取。请保留数据目录，使用 ledger.json.bak 或手动备份恢复。'+error.message);}
      }
    }
    this.data.settings={...DEFAULT_SETTINGS,...this.data.settings};
    this.data.records=this.data.records.map(r=>({...r,purchasedTime:r.purchasedTime||'',reimbursedAt:r.status==='reimbursed'?(r.reimbursedAt||r.updatedAt):null}));
    this.migrateInvoices();
  }
  migrateInvoices(data=this.data){
    data.invoices ||= [];
    // Older versions kept a single attachment per order. Register it once;
    // migration does not modify the file or claim to recover original JPEG bytes.
    for(const record of data.records){
      if(!record.invoiceId||data.invoices.some(i=>i.attachmentId===record.invoiceId))continue;
      let hash='';try{hash=createHash('sha256').update(fs.readFileSync(this.attachmentPath(record.invoiceId))).digest('hex');}catch{}
      const ext=path.extname(record.invoiceId);
      const oldName=record.invoiceName||('发票'+ext);
      const converted=ext==='.png'&&!/\.png$/i.test(oldName);
      data.invoices.push({id:record.invoiceId.slice(0,36),attachmentId:record.invoiceId,name:converted?path.parse(oldName).name+'.png':oldName,hash,invoiceNo:'',amount:null,issuedAt:'',seller:'',items:[],orderNos:[],rawText:'',warnings:converted?['旧版本曾转换为 PNG，无法还原上传前的图片文件；如需原文件请重新导入']:[],recordId:record.id,matchReason:'原账单附件',createdAt:record.updatedAt||new Date().toISOString(),deletedAt:null,legacyConverted:converted});
    }
  }
  snapshot(){return structuredClone(this.data);}
  async update(mutator){
    const operation=this.queue.then(async()=>{
      const draft=this.snapshot();
      const result=mutator(draft);
      const temp=this.file+'.'+randomUUID()+'.tmp';
      let handle;
      try{
        handle=await fs.promises.open(temp,'wx');
        await handle.writeFile(JSON.stringify(draft,null,2),'utf8');
        await handle.sync();
        await handle.close();handle=null;
        if(fs.existsSync(this.file))await fs.promises.copyFile(this.file,this.file+'.bak');
        await fs.promises.rename(temp,this.file);
        this.data=draft;
        return result;
      }catch(error){
        if(handle)await handle.close().catch(()=>{});
        await fs.promises.unlink(temp).catch(()=>{});
        throw error;
      }
    });
    this.queue=operation.catch(()=>{});
    return operation;
  }
  attachmentPath(id){
    if(typeof id!=='string'||!ATTACHMENT_ID.test(id))throw new Error('附件标识无效');
    return path.join(this.folder,'attachments',id);
  }
  async putAttachment(bytes,extension='png'){
    if(!EXTENSIONS.includes(extension))throw new Error('附件格式无效');
    const id=randomUUID()+'.'+extension;
    await fs.promises.writeFile(this.attachmentPath(id),bytes,{flag:'wx'});
    return id;
  }
  async attachment(id){return fs.promises.readFile(this.attachmentPath(id));}
}
module.exports={Store};
