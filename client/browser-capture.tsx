/// <reference lib="dom" />

import { useRef, type ReactNode } from 'react';

function transferFiles(transfer: DataTransfer): File[] {
  if (transfer.files.length) return Array.from(transfer.files);
  return Array.from(transfer.items).flatMap((item) => {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

export function BrowserFileCapture({
  children, onFiles, disabled,
}: {
  children: (chooseFiles: () => void) => ReactNode;
  onFiles: (files: File[]) => void;
  disabled: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);

  return (
    <div
      style={{ minWidth: 0 }}
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
