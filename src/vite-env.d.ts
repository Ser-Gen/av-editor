/// <reference types="vite/client" />

declare module '@ffmpeg/ffmpeg/worker?worker&url' {
  const url: string;
  export default url;
}
