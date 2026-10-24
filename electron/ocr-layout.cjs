function tileRegions(height, limit = 1536, overlap = 192) {
  if (height <= limit) return [{top:0, height, keepTop:0, keepBottom:height}];
  const regions = [];
  for (let top = 0; top < height; top += limit - overlap) {
    const size = Math.min(limit, height - top);
    regions.push({top, height:size, keepTop:top === 0 ? 0 : top + overlap / 2,
      keepBottom:top + size >= height ? height : top + size - overlap / 2});
    if (top + size >= height) break;
  }
  return regions;
}
function mapTileLines(result, tile, width) {
  // Undo fit:contain padding before mapping text boxes to the full screenshot.
  const resizedWidth = result.resizedImageWidth || width;
  const resizedHeight = result.resizedImageHeight || tile.height;
  const ratio = Math.min(resizedWidth / width, resizedHeight / tile.height);
  const padX = (resizedWidth - width * ratio) / 2;
  const padY = (resizedHeight - tile.height * ratio) / 2;
  return (result.texts || []).flatMap(line => {
    if (!line.text?.trim() || !line.box?.length) return [];
    const xs = line.box.map(point => (point[0] - padX) / ratio);
    const ys = line.box.map(point => (point[1] - padY) / ratio + tile.top);
    const box = {x0:Math.min(...xs), x1:Math.max(...xs), y0:Math.min(...ys), y1:Math.max(...ys)};
    const center = (box.y0 + box.y1) / 2;
    if (center < tile.keepTop || center >= tile.keepBottom) return [];
    return [{text:line.text.trim(), confidence:Math.max(0, Math.min(1, line.mean ?? line.score ?? 0)), ...box}];
  });
}
function readingOrder(lines) {
  const rows = [];
  for (const line of [...lines].sort((a,b) => a.y0-b.y0 || a.x0-b.x0)) {
    const center = (line.y0+line.y1)/2, height = line.y1-line.y0;
    const row = rows.find(row => Math.abs(row.center-center) <= Math.max(4, Math.min(row.height,height)*0.45));
    if (row) row.lines.push(line);
    else rows.push({center,height,lines:[line]});
  }
  return rows.sort((a,b) => a.center-b.center).map(row => row.lines.sort((a,b) => a.x0-b.x0).map(line => line.text).join(' ')).join('\n');
}
module.exports = {tileRegions, mapTileLines, readingOrder};
