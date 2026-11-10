// Images that the user pastes or drops into the prompt box. A large screenshot gets smaller before it
// goes to the daemon: the long side is at most MAX_SIDE pixels, as Claude does with its images.

export const MAX_SIDE = 1568;
export const MAX_IMAGES = 8; // The daemon limit (server.py MAX_PROMPT_IMAGES).
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** The size of an image with the long side at most ``max``. */
export function fitSize(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

/** The note at an image attachment for a model with no image input. */
export function noImageNote(model: string): string {
  return `${model} cannot read images. The agent gets a note in place of each image.`;
}

/** The image files of a paste or a drop. */
export function imageFiles(list: DataTransfer | null): File[] {
  if (!list) return [];
  const files = Array.from(list.files ?? []).filter((f) => IMAGE_TYPES.includes(f.type));
  if (files.length) return files;
  // Some apps put the image only in the items of the clipboard.
  return Array.from(list.items ?? [])
    .filter((i) => i.kind === "file" && IMAGE_TYPES.includes(i.type))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.readAsDataURL(blob);
  });
}

/** A data URL of the image for the prompt. A large image becomes smaller (PNG, or JPEG for a photo-size file). */
export async function imageToDataUrl(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const size = fitSize(bitmap.width, bitmap.height);
  if (size.width === bitmap.width && size.height === bitmap.height && file.size < 3_000_000) {
    bitmap.close();
    return readDataUrl(file);
  }
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const png = canvas.toDataURL("image/png");
  // A screenshot stays PNG (sharp text). A very large PNG becomes JPEG.
  return png.length < 4_000_000 ? png : canvas.toDataURL("image/jpeg", 0.88);
}
