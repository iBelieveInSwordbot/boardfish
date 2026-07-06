// Freeform Keynote-style slide: image + title + subtitle, drop-to-add image.

import { useRef, useState } from 'react';
import type { ProjectSettings, Slide } from '../types';
import type { Action } from '../store';
import { fileToPanelImage } from '../store';

type Props = {
  slide: Slide;
  settings: ProjectSettings;
  dispatch: React.Dispatch<Action>;
};

export function SlideView({ slide, settings, dispatch }: Props) {
  const [isDrop, setIsDrop] = useState(false);
  const dragCounter = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const setImage = async (file: File) => {
    const { dataUrl, name } = await fileToPanelImage(file);
    dispatch({ type: 'UPDATE_SLIDE', id: slide.id, patch: { imageDataUrl: dataUrl, imageName: name } });
  };

  const textColor = settings.colors.text;

  return (
    <div
      className={`slide-body ${isDrop ? 'slide-drop' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current += 1;
        setIsDrop(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) {
          dragCounter.current = 0;
          setIsDrop(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current = 0;
        setIsDrop(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) void setImage(file);
      }}
    >
      {slide.imageDataUrl ? (
        <div className="slide-image-wrap">
          <img className="slide-image" src={slide.imageDataUrl} alt={slide.imageName ?? ''} draggable={false} />
          <button
            className="slide-image-replace"
            onClick={(e) => {
              e.stopPropagation();
              fileRef.current?.click();
            }}
            title="Replace image"
          >
            Replace
          </button>
          <button
            className="slide-image-remove"
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'UPDATE_SLIDE', id: slide.id, patch: { imageDataUrl: null, imageName: null } });
            }}
            title="Remove image"
          >
            ×
          </button>
        </div>
      ) : (
        <button
          className="slide-image-placeholder"
          onClick={(e) => {
            e.stopPropagation();
            fileRef.current?.click();
          }}
          style={{ color: textColor, borderColor: `${textColor}40` }}
        >
          <span>Drop image here or click to upload (optional)</span>
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) await setImage(file);
          if (fileRef.current) fileRef.current.value = '';
        }}
      />
      <div className="slide-text-stack">
        <input
          className="slide-title"
          value={slide.title}
          placeholder="Section Title"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => dispatch({ type: 'UPDATE_SLIDE', id: slide.id, patch: { title: e.target.value } })}
          style={{ color: textColor, fontFamily: settings.fonts.family, fontWeight: 700 }}
        />
        <input
          className="slide-subtitle"
          value={slide.subtitle}
          placeholder="Subtitle (optional)"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => dispatch({ type: 'UPDATE_SLIDE', id: slide.id, patch: { subtitle: e.target.value } })}
          style={{ color: textColor, fontFamily: settings.fonts.family }}
        />
      </div>
    </div>
  );
}
