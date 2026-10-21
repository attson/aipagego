import type { ImagePart } from "@aipagego/shared/types";

type Props = {
  images: ImagePart[];
  onRemove: (idx: number) => void;
};

export function StagedImages({ images, onRemove }: Props) {
  if (images.length === 0) return null;
  return (
    <div
      data-testid="staged-images"
      className="flex gap-1.5 overflow-x-auto px-3 py-1.5 border-t border-zinc-800 bg-zinc-900"
    >
      {images.map((img, i) => (
        <div key={i} className="relative shrink-0">
          <img
            src={`data:${img.media_type};base64,${img.data}`}
            alt="staged"
            className="h-12 w-12 object-cover rounded border border-zinc-700"
          />
          <button
            type="button"
            aria-label={`remove image ${i + 1}`}
            onClick={() => onRemove(i)}
            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-800 text-zinc-200 border border-zinc-600 text-[10px] leading-none flex items-center justify-center hover:bg-red-900"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
