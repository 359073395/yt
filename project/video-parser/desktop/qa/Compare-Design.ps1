param([string]$SourceImage, [string]$Screenshot, [string]$Destination)
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile($SourceImage)
$rendered = [System.Drawing.Image]::FromFile($Screenshot)
# The browser was rendered at 1488 x 1058 CSS px, with a 0.85 display scale to fit
# the available capture surface. Exclude unused browser-canvas pixels only.
$canvas = New-Object System.Drawing.Bitmap ($source.Width * 2), $source.Height
$draw = [System.Drawing.Graphics]::FromImage($canvas)
$draw.Clear([System.Drawing.Color]::White)
$draw.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$draw.DrawImage($source, 0, 0, $source.Width, $source.Height)
$destinationRect = New-Object System.Drawing.Rectangle $source.Width, 0, $source.Width, $source.Height
$sourceRect = New-Object System.Drawing.Rectangle 0, 0, 1265, 899
$draw.DrawImage($rendered, $destinationRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
$canvas.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
$focused = $canvas.Clone((New-Object System.Drawing.Rectangle 0, 250, ($source.Width * 2), 220), $canvas.PixelFormat)
$focused.Save(($Destination -replace '\.png$', '-controls.png'), [System.Drawing.Imaging.ImageFormat]::Png)
[pscustomobject]@{SourceWidth=$source.Width;SourceHeight=$source.Height;CaptureWidth=$rendered.Width;CaptureHeight=$rendered.Height;Comparison=$Destination}
$focused.Dispose(); $draw.Dispose(); $canvas.Dispose(); $source.Dispose(); $rendered.Dispose()
