const path = require('node:path');
const fs = require('node:fs');
const {Worker} = require('node:worker_threads');
const {Ocr: BasicOcr} = require('./ocr-tesseract.cjs');
const unpacked = value => value.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');

class Ocr {
  constructor(langPath, progress = () => {}) {
    this.langPath = langPath;
    this.progress = progress;
    this.queue = Promise.resolve();
    this.active = null;
    this.stopped = false;
    this.basic = new BasicOcr(langPath, progress);
  }
  isReady() {
    try {
      const models = path.join(path.dirname(require.resolve('@gutenye/ocr-models/node')), 'assets');
      return ['ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv4_rec_infer.onnx', 'ppocr_keys_v1.txt'].every(file => fs.existsSync(path.join(models, file)));
    } catch { return false; }
  }
  recognize(buffer, id) {
    const job = this.queue.then(async () => {
      if (this.stopped) throw new Error('识别已停止');
      try { return await this.enhanced(buffer, id); }
      catch (error) {
        if (this.stopped || error.code === 'OCR_IMAGE_LIMIT' || error.code === 'OCR_TIMEOUT') throw error;
        const result = await this.basic.recognize(buffer, id);
        return {...result, engine:'tesseract', warnings:['增强中文识别未能完成，已使用基础识别，请仔细核对']};
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async enhanced(buffer, id) {
    const worker = new Worker(unpacked(path.join(__dirname, 'ocr-worker.cjs')));
    this.active = worker;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(() => finish(Object.assign(new Error('识别超时，请裁剪到订单内容后重试'), {code:'OCR_TIMEOUT'})), 120000);
        worker.on('message', message => {
          if (message.type === 'progress') this.progress(id, message);
          else if (message.type === 'result') finish(null, message.result);
          else if (message.type === 'error') finish(Object.assign(new Error(message.error), {code:message.code}));
        });
        worker.once('error', error => finish(error));
        worker.once('exit', code => finish(new Error('识别进程已退出 (' + code + ')')));
        worker.postMessage({buffer});
      });
    } finally {
      // Recycle OpenCV/ONNX native memory per image, including failed jobs.
      await worker.terminate();
      if (this.active === worker) this.active = null;
    }
  }
  async stop() {
    this.stopped = true;
    if (this.active) await this.active.terminate();
    await this.basic.stop();
  }
}
module.exports = {Ocr};
