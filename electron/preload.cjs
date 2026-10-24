const {contextBridge,ipcRenderer}=require('electron');
const invoke=async(channel,...args)=>{
  const result=await ipcRenderer.invoke('shaoye:'+channel,...args);
  if(!result.ok)throw new Error(result.error);
  return result.data;
};
const subscribe=(channel,callback)=>{
  const listener=(_event,value)=>callback(value);
  ipcRenderer.on('shaoye:'+channel,listener);
  return ()=>ipcRenderer.removeListener('shaoye:'+channel,listener);
};
contextBridge.exposeInMainWorld('shaoye',{
  snapshot:()=>invoke('snapshot'),
  importImage:input=>invoke('importImage',input),
  retryOcr:id=>invoke('retryOcr',id),
  saveReceipt:input=>invoke('saveReceipt',input),
  setStatus:(id,status)=>invoke('setStatus',id,status),
  trash:id=>invoke('trash',id),
  restore:id=>invoke('restore',id),
  image:id=>invoke('image',id),
  attachInvoice:(id,input)=>invoke('attachInvoice',id,input),
  openInvoice:id=>invoke('openInvoice',id),
  importInvoice:input=>invoke('importInvoice',input),
  invoiceCandidates:id=>invoke('invoiceCandidates',id),
  matchInvoice:(id,recordId)=>invoke('matchInvoice',id,recordId),
  openInvoiceFile:id=>invoke('openInvoiceFile',id),
  removeInvoice:id=>invoke('removeInvoice',id),
  exportInvoicePackage:()=>invoke('exportInvoicePackage'),
  updateSettings:settings=>invoke('updateSettings',settings),
  exportCsv:ids=>invoke('exportCsv',ids),
  backup:()=>invoke('backup'),
  restoreBackup:()=>invoke('restoreBackup'),
  openDataFolder:()=>invoke('openDataFolder'),
  notifyTest:()=>invoke('notifyTest'),
  windowCommand:command=>invoke('windowCommand',command),
  onProgress:callback=>subscribe('progress',callback),
  onChanged:callback=>subscribe('changed',callback),
  onNavigate:callback=>subscribe('navigate',callback)
});
