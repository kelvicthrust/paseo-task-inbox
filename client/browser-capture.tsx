/// <reference lib="dom" />

import { useEffect, useRef, type ReactNode } from 'react';

function transferFiles(transfer: DataTransfer): File[] {
  if (transfer.files.length) return Array.from(transfer.files);
  return Array.from(transfer.items).flatMap((item) => {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

export function useKeyboardNavigation(web: boolean) {
  const keyboard = useRef(true);
  useEffect(() => {
    if (!web) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) keyboard.current = true;
    };
    const onPointerDown = () => { keyboard.current = false; };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [web]);
  return keyboard;
}

export function BrowserFileCapture({
  children, onFiles, onPointerInput, disabled,
}: {
  children: (chooseFiles: () => void) => ReactNode;
  onFiles: (files: File[]) => void;
  onPointerInput: () => void;
  disabled: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);

  return (
    <div
      style={{ minWidth: 0 }}
      onPointerDownCapture={onPointerInput}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        if (!disabled) onFiles(transferFiles(event.dataTransfer));
      }}
      onPaste={(event) => {
        if (disabled) return;
        const files = transferFiles(event.clipboardData);
        if (files.length === 0) return;
        if (!event.clipboardData.types.includes('text/plain')) event.preventDefault();
        onFiles(files);
      }}
    >
      {children(() => picker.current?.click())}
      <input
        ref={picker}
        hidden
        type="file"
        multiple
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        disabled={disabled}
        onChange={(event) => {
          onFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = '';
        }}
      />
    </div>
  );
}
