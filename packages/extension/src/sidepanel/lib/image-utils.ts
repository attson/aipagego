import type { ImagePart } from "@aipagego/shared/types";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_TURN = 5;
const SUPPORTED: ReadonlyArray<ImagePart["media_type"]> = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

function isSupportedType(t: string): t is ImagePart["media_type"] {
  return (SUPPORTED as ReadonlyArray<string>).includes(t);
}

/**
 * Convert a File / Blob into an ImagePart. Throws on too-large or
 * unsupported types — callers should surface the message to the user.
 */
export async function fileToImagePart(file: File | Blob): Promise<ImagePart> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限`);
  }
  if (!isSupportedType(file.type)) {
    throw new Error(`不支持的图片类型：${file.type || "(unknown)"}`);
  }
  const buf = await file.arrayBuffer();
  return {
    type: "image",
    media_type: file.type,
    data: arrayBufferToBase64(buf),
  };
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // happy-dom + browsers both have btoa
  return btoa(bin);
}
