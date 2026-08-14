import { formatTimecode } from './time';

export function frameFileNameFromTime(seconds: number): string {
  const label = formatTimecode(seconds).replace(/:/g, '-').replace(/\./g, '-');
  return `frame_${label}.png`;
}

export function captureCanvasAsPngFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to capture frame'));
        return;
      }
      resolve(new File([blob], name, { type: 'image/png' }));
    }, 'image/png');
  });
}
