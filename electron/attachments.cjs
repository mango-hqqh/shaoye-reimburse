const EXTENSIONS = ['png','pdf','jpg','jpeg','webp','bmp'];
const ATTACHMENT_ID = /^[a-f0-9-]{36}\.(png|pdf|jpg|jpeg|webp|bmp)$/;
function fileExtension(bytes) {
  if (bytes.subarray(0,5).toString()==='%PDF-') return 'pdf';
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'jpg';
  if (bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP') return 'webp';
  if (bytes.subarray(0,2).toString()==='BM') return 'bmp';
  throw new Error('请选择 PDF、PNG、JPG、WEBP 或 BMP 发票原文件');
}
function validAttachment(bytes, extension) {
  try { return fileExtension(bytes)===(extension==='jpeg'?'jpg':extension); } catch { return false; }
}
module.exports={EXTENSIONS,ATTACHMENT_ID,fileExtension,validAttachment};
