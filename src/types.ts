export type Status = 'needs_invoice' | 'ready' | 'submitted' | 'reimbursed';
export type Page = 'overview' | 'records' | 'invoices' | 'reminders' | 'archive' | 'trash' | 'settings';
export type Receipt = {
  id: string; title: string; merchant: string; amount: number | null; purchasedAt: string; purchasedTime: string; category: string;
  status: Status; invoiceDueDate: string; reimbursementDueDate: string; orderNo: string; note: string;
  reimbursedAt: string | null; reviewed: boolean; createdAt: string; updatedAt: string; deletedAt: string | null; imageId: string | null;
  sourceName: string; sourceHash: string; rawText: string; confidence: number; warnings: string[];
  invoiceId: string | null; invoiceName: string; ocrEngine?: string;
};
export type Settings = { invoiceDays: number; reimbursementDays: number; reminderDays: number; reminderTime: string; notifications: boolean; closeToTray: boolean; startAtLogin: boolean; companyName: string; taxNumber: string; };
export type Invoice = {
  id:string; attachmentId:string; name:string; hash:string; invoiceNo:string; amount:number|null; issuedAt:string;
  seller:string; items:string[]; orderNos:string[]; rawText:string; warnings:string[]; recordId:string|null;
  matchReason:string; createdAt:string; deletedAt:string|null; legacyConverted?:boolean; invoiceNos?:string[];
};
export type InvoiceCandidate = {recordId:string;score:number;reason:string;};
export type Snapshot = {records: Receipt[]; invoices:Invoice[]; settings: Settings; dataDir: string; recovered: boolean; packaged: boolean; version: string; ocrReady: boolean;};
export type ImageInput = {name: string; bytes: Uint8Array; requestId?: string;};
export type Progress = {id: string; status: string; progress: number;};
export type Editable = Pick<Receipt,'title'|'merchant'|'amount'|'purchasedAt'|'purchasedTime'|'category'|'status'|'invoiceDueDate'|'reimbursementDueDate'|'orderNo'|'note'> & {id?:string};
export type Api = {
  snapshot():Promise<Snapshot>; importImage(input:ImageInput):Promise<{record:Receipt;duplicate:boolean}>;
  retryOcr(id:string):Promise<Receipt>; saveReceipt(input:Editable):Promise<Receipt>; setStatus(id:string,status:Status):Promise<void>;
  trash(id:string):Promise<void>; restore(id:string):Promise<void>; image(id:string):Promise<string|null>;
  attachInvoice(id:string,input:ImageInput):Promise<Receipt>; openInvoice(id:string):Promise<void>;
  importInvoice(input:ImageInput):Promise<{invoice:Invoice;duplicate:boolean;matched:boolean;candidates:InvoiceCandidate[]}>;
  invoiceCandidates(id:string):Promise<InvoiceCandidate[]>; matchInvoice(id:string,recordId:string|null):Promise<Invoice>;
  openInvoiceFile(id:string):Promise<void>; removeInvoice(id:string):Promise<void>;
  exportInvoicePackage():Promise<{exported:boolean;invoiceCount:number;recordCount:number;unmatchedCount:number}>;
  updateSettings(settings:Settings):Promise<Settings>; exportCsv(ids:string[]):Promise<boolean>;
  backup():Promise<boolean>; restoreBackup():Promise<number|null>; openDataFolder():Promise<void>; notifyTest():Promise<boolean>;
  windowCommand(command:'minimize'|'maximize'|'close'|'quit'):Promise<void>;
  onProgress(callback:(progress:Progress)=>void):()=>void; onChanged(callback:()=>void):()=>void;
  onNavigate(callback:(page:Page)=>void):()=>void;
};
declare global {interface Window {shaoye: Api;}}
