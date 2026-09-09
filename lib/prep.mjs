// Подготовка кадра для ИИ: центр-кроп в квадрат, 1024², JPEG q85. Файл → файл, без base64 в памяти.
import sharp from 'sharp';

export async function prepGuest(inPath, outPath, size = 1024) {
  await sharp(inPath)
    .rotate() // EXIF
    .resize(size, size, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 85, mozjpeg: true })
    .toFile(outPath);
  return outPath;
}
