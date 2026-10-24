function invoiceNumbers(invoice){
  return [...new Set([invoice.invoiceNo,...(invoice.invoiceNos||[])].filter(value=>/^\d{20}$/.test(value)))];
}
// Include soft-deleted historical files: removing a copy must not make an
// already reimbursed invoice eligible for another claim.
function reimbursedInvoiceKeys(records,invoices){
  const paid=new Set(records.filter(record=>record.status==='reimbursed').map(record=>record.id));
  const numbers=new Set(),hashes=new Set();
  for(const invoice of invoices){
    if(!paid.has(invoice.recordId))continue;
    for(const number of invoiceNumbers(invoice))numbers.add(number);
    if(invoice.hash)hashes.add(invoice.hash);
  }
  return {numbers,hashes};
}
function isReimbursedInvoice(invoice,keys){
  return !!invoice.hash&&keys.hashes.has(invoice.hash)||invoiceNumbers(invoice).some(number=>keys.numbers.has(number));
}
module.exports={invoiceNumbers,reimbursedInvoiceKeys,isReimbursedInvoice};
