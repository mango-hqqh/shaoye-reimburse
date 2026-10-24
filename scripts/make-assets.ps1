Add-Type -AssemblyName System.Drawing
$assetFolder = Join-Path $PSScriptRoot '..\assets'
$fixtureFolder = Join-Path $PSScriptRoot '..\tests\fixtures'
[System.IO.Directory]::CreateDirectory($assetFolder) | Out-Null
[System.IO.Directory]::CreateDirectory($fixtureFolder) | Out-Null
$bitmap = New-Object System.Drawing.Bitmap 256,256
$canvas = [System.Drawing.Graphics]::FromImage($bitmap)
$canvas.SmoothingMode = 'AntiAlias'
$canvas.Clear([System.Drawing.Color]::Transparent)
$background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#285749'))
$shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
$shape.AddArc(4,4,80,80,180,90)
$shape.AddArc(172,4,80,80,270,90)
$shape.AddArc(172,172,80,80,0,90)
$shape.AddArc(4,172,80,80,90,90)
$shape.CloseFigure()
$canvas.FillPath($background,$shape)
$paper = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#e9eddb'))
$points = [System.Drawing.Point[]]@([System.Drawing.Point]::new(73,45),[System.Drawing.Point]::new(183,45),[System.Drawing.Point]::new(183,201),[System.Drawing.Point]::new(169,190),[System.Drawing.Point]::new(155,201),[System.Drawing.Point]::new(141,190),[System.Drawing.Point]::new(127,201),[System.Drawing.Point]::new(113,190),[System.Drawing.Point]::new(99,201),[System.Drawing.Point]::new(85,190),[System.Drawing.Point]::new(73,201))
$canvas.FillPolygon($paper,$points)
$line = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#658362'),7)
$line.StartCap='Round';$line.EndCap='Round'
$canvas.DrawLine($line,95,82,157,82)
$canvas.DrawLine($line,95,108,157,108)
$canvas.DrawLine($line,95,134,132,134)
$coin=[System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#c4d99b'))
$canvas.FillEllipse($coin,153,145,60,60)
$checkPen=[System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#376144'),5)
$checkPen.StartCap='Round';$checkPen.EndCap='Round'
$canvas.DrawLine($checkPen,168,175,179,185)
$canvas.DrawLine($checkPen,179,185,198,165)
$pngFile = Join-Path $assetFolder 'icon.png'
$bitmap.Save($pngFile,[System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes=[System.IO.File]::ReadAllBytes($pngFile)
$icoStream=[System.IO.File]::Create((Join-Path $assetFolder 'icon.ico'))
$writer=[System.IO.BinaryWriter]::new($icoStream)
$writer.Write([UInt16]0);$writer.Write([UInt16]1);$writer.Write([UInt16]1)
$writer.Write([byte]0);$writer.Write([byte]0);$writer.Write([byte]0);$writer.Write([byte]0)
$writer.Write([UInt16]1);$writer.Write([UInt16]32);$writer.Write([UInt32]$pngBytes.Length);$writer.Write([UInt32]22);$writer.Write($pngBytes)
$writer.Dispose();$canvas.Dispose();$bitmap.Dispose();$background.Dispose();$shape.Dispose();$paper.Dispose();$line.Dispose();$coin.Dispose();$checkPen.Dispose()
$sample=[System.Drawing.Bitmap]::new(1000,900)
$g=[System.Drawing.Graphics]::FromImage($sample)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint='AntiAliasGridFit'
$font=[System.Drawing.Font]::new('Microsoft YaHei',29,[System.Drawing.FontStyle]::Regular,[System.Drawing.GraphicsUnit]::Pixel)
$bold=[System.Drawing.Font]::new('Microsoft YaHei',42,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Pixel)
$ink=[System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(32,38,34))
$g.DrawString('示例消费凭证',$bold,$ink,55,45)
$rows=@('商家：京东自营店','商品：罗技无线鼠标','订单号：202610220001','商品金额：￥329.00','优惠金额：￥30.00','实付金额：￥299.00','支付时间：2026-10-20 14:30:00')
$sampleY=160
foreach($row in $rows){$g.DrawString($row,$font,$ink,58,$sampleY);$sampleY+=80}
$sample.Save((Join-Path $fixtureFolder 'receipt.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$sample.Dispose();$font.Dispose();$bold.Dispose();$ink.Dispose()
Write-Output 'Generated application icon and OCR sample.'
