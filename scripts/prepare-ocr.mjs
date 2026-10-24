import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
const require=createRequire(import.meta.url);
const models=join(dirname(require.resolve('@gutenye/ocr-models/node')),'assets');
const hashes={
  'ch_PP-OCRv4_det_infer.onnx':'30a86f5731181461d08021402766601e4302a9b9b9666be8aff402696339cdff',
  'ch_PP-OCRv4_rec_infer.onnx':'06b3e6af6c59a1ba5d53790ed8c2e4b2de389870b6cf5a97f349f3412cb269c0',
  'ppocr_keys_v1.txt':'28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7'
};
for(const [name,expected] of Object.entries(hashes)){
  const digest=createHash('sha256').update(await readFile(join(models,name))).digest('hex');
  if(digest!==expected)throw new Error('Chinese OCR model checksum mismatch: '+name);
  console.log(name+': verified');
}
const folder=resolve('assets/tessdata');
await mkdir(folder,{recursive:true});
for(const lang of ['chi_sim','eng']){
  const target=resolve(folder,lang+'.traineddata.gz');
  try { if((await stat(target)).size > 100000){gunzipSync(await readFile(target)); console.log(lang+': ready');continue;} } catch{}
  const url='https://tessdata.projectnaptha.com/4.0.0/'+lang+'.traineddata.gz';
  console.log('Downloading offline language: '+lang);
  const response=await fetch(url,{signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw new Error('Language download failed: '+response.status);
  const data=Buffer.from(await response.arrayBuffer());
  if(gunzipSync(data).length<100000)throw new Error('Invalid language model');
  await writeFile(target,data);
  console.log(lang+': '+(data.length/1024/1024).toFixed(1)+' MB');
}
