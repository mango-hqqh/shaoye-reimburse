import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {readInvoice}=require('../electron/invoice-reader.cjs'),{Ocr}=require('../electron/ocr.cjs');
const expected=JSON.parse(await readFile('tests/fixtures/invoices.expected.json','utf8'));
const results=[],ocr=new Ocr(resolve('assets/tessdata'));
try{
  for(const file of ['invoice-text.pdf','invoice-scan.pdf','invoice-original.jpg']){
    const start=Date.now(),input=await readFile(join('tests/fixtures',file));
    const result=await readInvoice(input,ocr,file);
    console.log(file,JSON.stringify(result));
    assert.equal(result.automatic,true,file+' should read confidently');
    assert.equal(result.parsed.amount,expected.amount);
    assert.equal(result.parsed.issuedAt,expected.issuedAt);
    assert.equal(result.parsed.seller,expected.seller);
    assert.ok(result.parsed.items.some(item=>item.includes(expected.item)));
    assert.ok(result.parsed.orderNos.includes(expected.orderNo));
    assert.equal(result.parsed.invoiceNo,file==='invoice-text.pdf'?expected.textInvoiceNo:file==='invoice-scan.pdf'?expected.scanInvoiceNo:'24612000000012345680');
    results.push({file,...result,elapsedMs:Date.now()-start});
  }
  const mixed=await readInvoice(await readFile('tests/fixtures/invoice-mixed.pdf'),ocr,'mixed');
  assert.equal(mixed.automatic,false,'Mixed multi-invoice PDF must require splitting');
  assert.deepEqual(mixed.parsed.invoiceNos,[expected.textInvoiceNo,expected.scanInvoiceNo]);
  assert.match(mixed.parsed.warnings.join(' '),/多张发票/);
  const corrupt=await readInvoice(Buffer.from('%PDF-1.7\nbroken'),ocr,'corrupt');
  assert.equal(corrupt.automatic,false);assert.match(corrupt.parsed.warnings.join(' '),/原文件已保存/);
  await mkdir('test-results',{recursive:true});
  await writeFile('test-results/invoice-reader-report.json',JSON.stringify({passed:true,results,mixed,corrupt},null,2));
  console.log('PASS: Chinese text PDF, scanned PDF and JPEG recognition, mixed-page multi-invoice protection, malformed PDF recovery');
}finally{await ocr.stop();}
