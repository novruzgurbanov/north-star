// Proof images are downscaled in the browser before they leave it: at most 1280 px wide, JPEG.
// They are sent once for the vision check and never stored (PANELS.md section 3).

const MAX_WIDTH = 1280
const MAX_BASE64 = 5_400_000 // the server accepts up to 4 MB of image, which is ~5.6 M base64 characters

/** Draws an image or video frame into a JPEG data URL, scaled to fit MAX_WIDTH. */
export function toJpeg(source: CanvasImageSource, width: number, height: number): string {
  const scale = Math.min(1, MAX_WIDTH / Math.max(1, width))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const g = canvas.getContext('2d')
  if (!g) throw new Error('Canvas unavailable')
  g.drawImage(source, 0, 0, canvas.width, canvas.height)
  let url = canvas.toDataURL('image/jpeg', 0.8)
  if (url.length > MAX_BASE64) url = canvas.toDataURL('image/jpeg', 0.6)
  canvas.width = canvas.height = 0
  if (url.length > MAX_BASE64) throw new Error('Image too large')
  return url
}

/** Reads a picked file (any browser-decodable image) into a downscaled JPEG data URL. */
export async function fileToJpeg(file: File): Promise<string> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file).catch(() => null)
    if (bitmap) {
      try { return toJpeg(bitmap, bitmap.width, bitmap.height) } finally { bitmap.close() }
    }
  }
  const src = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Not an image'))
      el.src = src
    })
    return toJpeg(img, img.naturalWidth, img.naturalHeight)
  } finally {
    URL.revokeObjectURL(src)
  }
}

/** The API takes bare base64, like the desktop's focus checks. */
export const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1)
