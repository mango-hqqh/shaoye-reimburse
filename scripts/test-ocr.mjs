import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import sharp from 'sharp';
const require=createRequire(import.meta.url);
const {Ocr}=require('../electron/ocr.cjs');
const {parseReceipt}=require('../shared/parser.cjs');
const {Ocr:LegacyOcr}=require('../electron/ocr-tesseract.cjs');
const results=resolve('test-results');
await mkdir(results,{recursive:true});
const expected=JSON.parse(await readFile('tests/fixtures/orders.expected.json','utf8'));
const ocr=new Ocr(resolve('assets/tessdata'));
const report={syntheticFixtures:true,engine:'paddleocr-v4',cases:[]};
async function check(name,buffer,item){
  const start=Date.now();
  const result=await ocr.recognize(buffer,name);
  const parsed=parseReceipt(result.text);
  const row={name,elapsedMs:Date.now()-start,...result,parsed};
  report.cases.push(row);
  await writeFile(join(results,'ocr-regression.json'),JSON.stringify(report,null,2));
  assert.equal(result.engine,'paddleocr-v4',name+' must use the new engine, not silently fall back');
  assert.equal(parsed.amount,item.amount,name+' paid total');
  assert.equal(parsed.purchasedAt,item.purchaseDate,name+' payment date');
  assert.equal(parsed.purchasedTime,item.purchaseTime,name+' payment time');
  assert.equal(parsed.merchant,item.merchant,name+' merchant');
  assert.equal(parsed.orderNo,item.orderNo,name+' order number');
  for(const word of item.titleKeywords) assert.ok(parsed.title.includes(word),name+' missing title word '+word+': '+parsed.title);
  assert.ok(!parsed.warnings.some(w=>w.includes('多个商品')),name+' must remain a single product');
  console.log('PASS: '+name+' → '+parsed.title+' / ¥'+parsed.amount+' / '+parsed.purchasedAt+' '+parsed.purchasedTime+' ('+row.elapsedMs+'ms)');
}
try {
  assert.equal(ocr.isReady(),true);
  for(const item of expected){
    const buffer=await readFile(join('tests/fixtures',item.file));
    await check(item.file,buffer,item);
    const compressed=await sharp(buffer).resize({width:480}).jpeg({quality:75}).toBuffer();
    await check(item.file+'-480px-jpeg',compressed,item);
  }
  const original=await readFile('tests/fixtures/jd-order.png');
  const long=await sharp(original).extend({top:2600,bottom:800,left:0,right:0,background:'#f5f5f5'}).png().toBuffer();
  await check('long-5230px-order',long,expected[1]);
  const blank=await sharp({create:{width:750,height:1200,channels:3,background:'#ffffff'}}).png().toBuffer();
  const empty=await ocr.recognize(blank,'blank');
  assert.equal(empty.engine,'paddleocr-v4');assert.equal(parseReceipt(empty.text).amount,null);
  console.log('PASS: blank image does not invent an amount');
  if(process.argv.includes('--compare')){
    const old=new LegacyOcr(resolve('assets/tessdata'),()=>{});
    try {
      report.legacy=[];
      for(const item of expected){
        // Match v1.0.0 main-process image upscaling before its Tesseract pass.
        const buffer=await sharp(await readFile(join('tests/fixtures',item.file))).resize({width:1400}).png().toBuffer();
        const start=Date.now(),result=await old.recognize(buffer,item.file);
        report.legacy.push({name:item.file,elapsedMs:Date.now()-start,...result});
      }
    }finally{await old.stop();}
  }
  report.passed=true;
}finally{
  await ocr.stop();
  await writeFile(join(results,'ocr-regression.json'),JSON.stringify(report,null,2));
}
