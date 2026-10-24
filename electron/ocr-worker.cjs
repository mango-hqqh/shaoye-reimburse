const {parentPort} = require('node:worker_threads');
const path = require('node:path');
const sharp = require('sharp');
const {tileRegions, mapTileLines, readingOrder} = require('./ocr-layout.cjs');
sharp.cache(false);
sharp.concurrency(1);
const report = (status, progress) => parentPort.postMessage({type:'progress', status, progress});

parentPort.once('message', async ({buffer}) => {
  try {
    report('正在准备增强中文识别', 0.03);
    const {default:GutenOcr} = await import('@gutenye/ocr-node');
    const modelRoot = path.join(path.dirname(require.resolve('@gutenye/ocr-models/node')), 'assets').replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');
    const engine = await GutenOcr.create({models:{
      detectionPath:path.join(modelRoot, 'ch_PP-OCRv4_det_infer.onnx'),
      recognitionPath:path.join(modelRoot, 'ch_PP-OCRv4_rec_infer.onnx'),
      dictionaryPath:path.join(modelRoot, 'ppocr_keys_v1.txt')
    }, onnxOptions:{executionProviders:['cpu'], intraOpNumThreads:2, interOpNumThreads:1}});
    const input = sharp(Buffer.from(buffer), {limitInputPixels:40000000}).rotate().flatten({background:'#ffffff'});
    const metadata = await input.metadata();
    const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
    const sourceWidth = rotated ? metadata.height : metadata.width;
    const sourceHeight = rotated ? metadata.width : metadata.height;
    const width = Math.min(1280, Math.max(Math.min(750, sourceWidth*2), sourceWidth));
    const scaledHeight = Math.round(sourceHeight * width / sourceWidth);
    if (width * scaledHeight > 20000000 || tileRegions(scaledHeight).length > 36) {
      const error = new Error('截图过长，请分成几张订单截图上传');
      error.code = 'OCR_IMAGE_LIMIT';
      throw error;
    }
    const normalized = await input.resize({width}).removeAlpha().png().toBuffer();
    const {width:actualWidth, height} = await sharp(normalized).metadata();
    const regions = tileRegions(height);
    if (regions.length > 36) throw new Error('截图过长，请分成几张订单截图上传');
    const lines = [];
    for (let index=0; index<regions.length; index++) {
      const tile = regions[index];
      report(regions.length>1 ? `正在识别订单内容（${index+1}/${regions.length}）` : '正在识别订单内容', 0.12+0.82*index/regions.length);
      const {data,info} = await sharp(normalized).extract({left:0,top:tile.top,width:actualWidth,height:tile.height}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      const result = await engine.detect({data,width:info.width,height:info.height});
      lines.push(...mapTileLines(result,tile,actualWidth));
    }
    const text = readingOrder(lines);
    if (!text.trim()) {
      const stats = await sharp(normalized).stats();
      if (stats.channels.some(channel => channel.stdev > 8)) throw new Error('增强识别未检测到文字');
    }
    const count = lines.reduce((sum,line) => sum+line.text.length,0);
    const confidence = count ? Math.round(100*lines.reduce((sum,line) => sum+line.confidence*line.text.length,0)/count) : 0;
    report('正在提取商品、实付金额和日期', 0.98);
    parentPort.postMessage({type:'result',result:{text, confidence, engine:'paddleocr-v4', warnings:lines.some(line => line.confidence<0.75) ? ['部分文字识别不确定，请对照原图核对'] : []}});
  } catch (error) { parentPort.postMessage({type:'error',error:error?.message||String(error),code:error?.code}); }
});
