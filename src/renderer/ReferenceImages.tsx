import React from "react";
import { ArrowDown, ArrowUp, Image, X } from "lucide-react";
import "./reference-images.css";

export type ReferenceImage = {
  id: string;
  name: string;
  previewUrl?: string;
  missing?: boolean;
  hint?: string;
};

/** The displayed order is also the order sent to the video model. */
export function ReferenceImages({
  images,
  label,
  disabled = false,
  editableFrom = 0,
  onRemove,
  onMove,
}: {
  images: ReferenceImage[];
  label: string;
  disabled?: boolean;
  editableFrom?: number;
  onRemove?: (id: string) => void;
  onMove?: (id: string, delta: number) => void;
}) {
  if (!images.length) return null;
  return (
    <ol className="reference-images" aria-label={label}>
      {images.map((image, index) => (
        <li key={image.id} className={image.missing ? "is-missing" : ""}>
          <div className="reference-thumbnail">
            {image.previewUrl && !image.missing ? (
              <img src={image.previewUrl} alt={image.name} loading="lazy" />
            ) : (
              <Image size={19} aria-hidden="true" />
            )}
          </div>
          <div className="reference-description">
            <strong>Image {index + 1}</strong>
            <span title={image.name}>{image.name}</span>
            {(image.missing || image.hint) && (
              <small>
                {image.missing
                  ? "Missing image · remove or relink"
                  : image.hint}
              </small>
            )}
          </div>
          {index >= editableFrom && (onRemove || onMove) && (
            <div className="reference-actions">
              {onMove && images.length - editableFrom > 1 && (
                <>
                  <button
                    type="button"
                    disabled={disabled || index === editableFrom}
                    aria-label={`Move image ${index + 1} earlier`}
                    title="Move earlier"
                    onClick={() => onMove(image.id, -1)}
                  >
                    <ArrowUp size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={disabled || index === images.length - 1}
                    aria-label={`Move image ${index + 1} later`}
                    title="Move later"
                    onClick={() => onMove(image.id, 1)}
                  >
                    <ArrowDown size={12} aria-hidden="true" />
                  </button>
                </>
              )}
              {onRemove && (
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove image ${index + 1}: ${image.name}`}
                  title="Remove image"
                  onClick={() => onRemove(image.id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
