/**
 * The one-shot FFmpeg presets, transcribed from `shir-effects.txt`.
 *
 * This is the only file in the project that maps one-to-one onto that source: every `args`
 * array below is the command line exactly as it was written there, in the same order. That
 * is deliberate — these are recipes someone tuned by running them, and paraphrasing a
 * filter chain into "our" style is how a working command line quietly stops working. What
 * this file adds around them is the part the source has no room for: which group a preset
 * belongs in, what it costs, and what to call the file it produces.
 *
 * Nothing here re-encodes the timeline. A preset takes one library asset and produces a
 * *new* one, so the original is always still there to compare against — and so a slow job
 * can be cancelled without having destroyed anything.
 */

import type { BuiltinEffectType } from '../types/editor';

/**
 * What to use instead, when the renderer can already do this.
 *
 * Recorded rather than acted on: the two are not the same picture. FFmpeg filters in YUV and
 * the compositor works in RGB, so a shader `eq` and `eq=contrast=1.1` disagree in the
 * shadows. Silently substituting one for the other would mean the same preset name produced
 * two different files depending on the machine, which is exactly the property this table
 * exists to prevent. So the dialog says what the alternative is and lets you pick.
 */
export interface GpuEquivalent {
  /** The built-in effect that covers it, when one does. */
  effect?: BuiltinEffectType;
  /** Named in a sentence: "the Sharpen effect", "the clip's own fade handles". */
  instead: string;
  /** Where the GPU version stops short, when it does. */
  limit?: string;
}

export type ToolGroup = 'Reframe' | 'Time' | 'Restore' | 'Look' | 'Deliver' | 'Fun';

export const TOOL_GROUPS: ToolGroup[] = [
  'Reframe',
  'Time',
  'Restore',
  'Look',
  'Deliver',
  'Fun',
];

export interface ToolPreset {
  /** The `value` from the source file, kept so a processed asset can name its recipe. */
  id: string;
  group: ToolGroup;
  /** Short enough for a menu row. The source's own longer name lives in `description`. */
  label: string;
  description: string;
  /** Appended to the source's name, in brackets: `holiday (reversed).mp4`. */
  suffix: string;
  /** Container the command line writes. Decides both the file name and the asset kind. */
  ext: 'mp4' | 'gif';
  /**
   * Very roughly, seconds of work per second of source: single-threaded WASM at about
   * 1080p. Calibrated to the order of magnitude, not the second — its whole job is to tell
   * "this finishes while you read the sentence" apart from "this finishes after lunch".
   */
  cost: number;
  /** Set where the estimate is long enough that starting one by accident is a real cost. */
  slow?: boolean;
  /**
   * The output is a different size or shape from the input.
   *
   * Only matters when the result replaces a clip: crops, placements and masked regions are
   * stored normalized, so they stay where they are while the picture underneath them moves.
   */
  reshapes?: boolean;
  /** Shown alongside the estimate when the preset does something surprising. */
  caveat?: string;
  /**
   * What the preset does to the excerpt's length. 1 for all but one of them.
   *
   * Only used to *state* the consequence before the run — the length that ends up on the
   * timeline is measured from the file FFmpeg actually produced, never from this number.
   */
  durationScale?: number;
  /** Set when the renderer already does this in real time. */
  gpu?: GpuEquivalent;
  /** The command line, verbatim from the source, ending in its own output file name. */
  args: string[];
  /**
   * The one escape hatch from verbatim: a preset whose numbers only suit one clip length.
   * Applied to a copy of `args` just before the job runs, and told the length of the
   * material actually going through — the excerpt, when there is one, not the file.
   */
  adapt?: (args: string[], sourceSeconds: number) => string[];
}

/** Baseline costs by x264 preset, so the numbers below stay comparable to each other. */
const ULTRAFAST = 2;
const MEDIUM = 6;
const SLOW = 12;

export const TOOL_PRESETS: ToolPreset[] = [
  // --------------------------------------------------------------------- Reframe
  {
    id: 'force-9-16',
    group: 'Reframe',
    label: 'Force 9:16 (black bars)',
    description: 'Pads to a vertical frame without cropping anything away.',
    suffix: '9:16',
    ext: 'mp4',
    gpu: { instead: "the project's frame size, which re-anchors every placement with it" },
    reshapes: true,
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "scale=iw*sar:ih,setsar=1,pad='if(gt(iw/ih,9/16),iw,round(ih*9/16/2)*2)':'if(gt(iw/ih,9/16),round(iw*16/9/2)*2,ih)':(ow-iw)/2:(oh-ih)/2:black", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "output.mp4"],
  },
  {
    id: 'force-16-9',
    group: 'Reframe',
    label: 'Force 16:9 (black bars)',
    description: 'Pads to a widescreen frame without cropping anything away.',
    suffix: '16:9',
    ext: 'mp4',
    gpu: { instead: "the project's frame size, which re-anchors every placement with it" },
    reshapes: true,
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "scale=iw*sar:ih,setsar=1,pad='if(gt(iw/ih,16/9),iw,round(ih*16/9/2)*2)':'if(gt(iw/ih,16/9),round(iw*9/16/2)*2,ih)':(ow-iw)/2:(oh-ih)/2:black", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "output.mp4"],
  },
  {
    id: 'resize-720p',
    group: 'Reframe',
    label: 'Resize to 720p',
    description: 'Lanczos scale into 1280 × 720, padded if the shape does not match.',
    suffix: '720p',
    ext: 'mp4',
    gpu: { instead: "the project's frame size, or the export size override" },
    reshapes: true,
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "scale=iw*sar:ih:flags=lanczos,setsar=1,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "output.mp4"],
  },
  {
    id: 'resize-1080p',
    group: 'Reframe',
    label: 'Resize to 1080p',
    description: 'Lanczos scale into 1920 × 1080, padded if the shape does not match.',
    suffix: '1080p',
    ext: 'mp4',
    gpu: { instead: "the project's frame size, or the export size override" },
    reshapes: true,
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "scale=iw*sar:ih:flags=lanczos,setsar=1,scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "output.mp4"],
  },
  {
    id: 'resize-2k',
    group: 'Reframe',
    label: 'Resize to 2K',
    description: 'Lanczos scale into 2560 × 1440, padded if the shape does not match.',
    suffix: '2K',
    ext: 'mp4',
    gpu: { instead: "the project's frame size, or the export size override" },
    reshapes: true,
    cost: MEDIUM * 2,
    args: ["-threads", "0", "-vf", "scale=iw*sar:ih:flags=lanczos,setsar=1,scale=2560:1440:force_original_aspect_ratio=decrease:flags=lanczos,pad=2560:1440:(ow-iw)/2:(oh-ih)/2:black", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "output.mp4"],
  },
  {
    id: 'resize-4k',
    group: 'Reframe',
    label: 'Resize to 4K',
    description: 'Lanczos scale into 3840 × 2160. Upscaling adds no detail the source lacks.',
    suffix: '4K',
    ext: 'mp4',
    gpu: { instead: "the project's frame size, or the export size override" },
    reshapes: true,
    cost: MEDIUM * 4,
    slow: true,
    args: ["-threads", "0", "-vf", "scale=iw*sar:ih:flags=lanczos,setsar=1,scale=3840:2160:force_original_aspect_ratio=decrease:flags=lanczos,pad=3840:2160:(ow-iw)/2:(oh-ih)/2:black", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "output.mp4"],
  },
  {
    id: 'rotate-90',
    group: 'Reframe',
    label: 'Rotate 90°',
    description: 'Turns the picture a quarter clockwise; width and height swap.',
    suffix: 'rotated',
    ext: 'mp4',
    reshapes: true,
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "transpose=1", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },
  {
    id: 'horizontal-flip',
    group: 'Reframe',
    label: 'Mirror horizontally',
    description: 'Flips left to right — the fix for footage shot on a front camera.',
    suffix: 'mirrored',
    ext: 'mp4',
    gpu: { effect: 'flip', instead: 'the Flip effect' },
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "hflip", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },

  // ------------------------------------------------------------------------ Time
  {
    id: 'reverse-playback',
    group: 'Time',
    label: 'Reverse',
    description: 'Plays picture and sound backwards.',
    suffix: 'reversed',
    ext: 'mp4',
    cost: SLOW,
    slow: true,
    caveat:
      'Reversing holds the whole clip in memory at once, so a long source can run the tab out of it. Try a trimmed copy first.',
    args: ["-threads", "0", "-vf", "reverse", "-af", "areverse", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },
  {
    id: 'time-lapse',
    group: 'Time',
    label: 'Time-lapse (8×)',
    description: 'Eight times faster, with the audio pitch-corrected to match.',
    suffix: 'time-lapse',
    ext: 'mp4',
    cost: MEDIUM,
    durationScale: 0.125,
    args: ["-threads", "0", "-vf", "setpts=0.125*PTS", "-af", "atempo=2.0,atempo=2.0,atempo=2.0", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },
  {
    id: 'convert-60fps',
    group: 'Time',
    label: 'Interpolate to 60 fps',
    description: 'Invents in-between frames with motion estimation. No AI, and no magic.',
    suffix: '60 fps',
    ext: 'mp4',
    cost: 80,
    slow: true,
    args: ["-threads", "0", "-vf", "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },
  {
    id: 'convert-120fps',
    group: 'Time',
    label: 'Interpolate to 120 fps',
    description: 'The same motion estimation, twice as many frames to invent.',
    suffix: '120 fps',
    ext: 'mp4',
    cost: 150,
    slow: true,
    args: ["-threads", "0", "-vf", "minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:vsbmc=1", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },
  {
    id: 'fade-in-out-1s',
    group: 'Time',
    label: 'Fade in and out (1s)',
    description: 'A one-second fade from black at the head and back to black at the tail.',
    suffix: 'faded',
    ext: 'mp4',
    gpu: { instead: "the clip's own fade handles" },
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "fade=t=in:st=0:d=1,fade=t=out:st=20:d=1", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-af", "afade=t=in:st=0:d=1,afade=t=out:st=20:d=1", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
    // The source hard-codes the fade-out at 20s, which is only the tail of a 21-second clip.
    // On anything else it either fades out mid-clip or never fades out at all, so the one
    // number that has to know the clip's length is the one number computed here.
    adapt: (args, sourceSeconds) => {
      const out = Math.max(0, sourceSeconds - 1);
      return args.map((arg) => arg.replace(/st=20:d=1/g, `st=${out.toFixed(3)}:d=1`));
    },
  },

  // --------------------------------------------------------------------- Restore
  {
    id: 'stabilize-deshake',
    group: 'Restore',
    label: 'Stabilize',
    description: 'Smooths handheld shake, then crops 5% to hide the edges it moves in.',
    suffix: 'stabilized',
    ext: 'mp4',
    cost: 30,
    slow: true,
    args: ["-threads", "0", "-vf", "deshake=rx=16:ry=16:edge=mirror,scale=iw*1.05:-1,crop=iw/1.05:ih/1.05", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "output.mp4"],
  },
  {
    id: 'deflicker',
    group: 'Restore',
    label: 'Deflicker',
    description: 'Evens out brightness pulsing across frames — old footage and time-lapses.',
    suffix: 'deflickered',
    ext: 'mp4',
    cost: 8,
    args: ["-threads", "0", "-vf", "deflicker=size=7:mode=am", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "output.mp4"],
  },
  {
    id: 'denoise',
    group: 'Restore',
    label: 'Denoise',
    description: 'Reduces grain and sensor noise. Fine texture goes with it.',
    suffix: 'denoised',
    ext: 'mp4',
    gpu: { effect: 'denoise', instead: 'the Denoise effect', limit: 'The effect is spatial only; hqdn3d also averages across time, which a per-frame shader cannot do.' },
    cost: 10,
    args: ["-threads", "0", "-vf", "hqdn3d=4:3:6:4", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },
  {
    id: 'enhance',
    group: 'Restore',
    label: 'Enhance',
    description: 'A gentle lift of contrast, brightness and saturation.',
    suffix: 'enhanced',
    ext: 'mp4',
    gpu: { effect: 'eq', instead: 'the Brightness / Contrast / Saturation effect' },
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "eq=contrast=1.1:brightness=0.02:saturation=1.1", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },
  {
    id: 'sharpen',
    group: 'Restore',
    label: 'Sharpen',
    description: 'Unsharp mask on the luma. Overdo it and the edges ring.',
    suffix: 'sharpened',
    ext: 'mp4',
    gpu: { effect: 'sharpen', instead: 'the Sharpen effect' },
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "unsharp=5:5:1.0:5:5:0.0", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },

  // ------------------------------------------------------------------------ Look
  {
    id: 'cinematic-grade-letterbox',
    group: 'Look',
    label: 'Cinematic grade (2.35:1)',
    description: 'A cool-shadow grade, letterboxed to a scope frame at 1920 × 816.',
    suffix: 'cinematic',
    ext: 'mp4',
    gpu: { effect: 'cinematic', instead: 'the Cinematic grade effect', limit: 'The letterbox is the project frame here, not something the effect draws.' },
    reshapes: true,
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "eq=contrast=1.1:brightness=0.02:saturation=1.2, colorbalance=rs=.05:bs=-.05,scale=1920:816:force_original_aspect_ratio=decrease,pad=1920:816:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },
  {
    id: 'black-white',
    group: 'Look',
    label: 'Black and white',
    description: 'Drops saturation to zero.',
    suffix: 'b&w',
    ext: 'mp4',
    gpu: { effect: 'blackWhite', instead: 'the Black & white effect' },
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "hue=s=0", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },
  {
    id: 'edge-detect',
    group: 'Look',
    label: 'Sketch lines',
    description: 'Edge detection, inverted: pencil lines on white.',
    suffix: 'sketch',
    ext: 'mp4',
    gpu: { effect: 'edgeDetect', instead: 'the Edge detect / sketch effect' },
    cost: 8,
    args: ["-threads", "0", "-vf", "edgedetect=low=0.1:high=0.3,negate", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },
  {
    id: 'pixelate',
    group: 'Look',
    label: 'Pixelate',
    description: 'Down to 160 wide and back up with nearest neighbour.',
    suffix: 'pixelated',
    ext: 'mp4',
    gpu: { effect: 'pixelate', instead: 'the Pixelate effect' },
    reshapes: true,
    cost: MEDIUM,
    args: ["-threads", "0", "-vf", "scale=160:90:force_original_aspect_ratio=decrease:flags=neighbor,scale=iw*12:ih*12:flags=neighbor", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "output.mp4"],
  },

  // --------------------------------------------------------------------- Deliver
  {
    id: 'x264-slow',
    group: 'Deliver',
    label: 'Compress',
    description: 'CRF 23 at the slow preset — the usual trade for finished content.',
    suffix: 'compressed',
    ext: 'mp4',
    cost: SLOW,
    args: ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-crf", "23", "-preset", "slow", "-threads", "0", "-x264-params", "threads=0", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "output.mp4"],
  },
  {
    id: 'x264-web-saas',
    group: 'Deliver',
    label: 'Compress for the web',
    description: 'Baseline profile, faststart, veryslow. Plays on almost anything.',
    suffix: 'web',
    ext: 'mp4',
    cost: 30,
    slow: true,
    caveat: 'This one also forces 60 fps, so a 24 or 30 fps source comes back longer to encode than it looks.',
    args: ["-fflags", "+nofillin", "-r", "60", "-crf", "25", "-preset", "veryslow", "-movflags", "+faststart", "-tune", "film", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level", "3", "output.mp4"],
  },
  {
    id: 'mute',
    group: 'Deliver',
    label: 'Strip audio',
    description: 'Drops the audio track and compresses the picture.',
    suffix: 'muted',
    ext: 'mp4',
    cost: SLOW,
    args: ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-crf", "23", "-preset", "slow", "-threads", "0", "-x264-params", "threads=0", "-an", "output.mp4"],
  },
  {
    id: 'to-gif',
    group: 'Deliver',
    label: 'Convert to GIF',
    description: '12 fps, 480 wide, with a palette generated from the clip itself.',
    suffix: 'gif',
    ext: 'gif',
    reshapes: true,
    cost: 10,
    caveat:
      'A GIF joins the library as an image, so the timeline uses one frame of it. It is for sending somewhere else, not for editing with.',
    args: ["-threads", "0", "-filter_complex", "[0:v] fps=12,scale=480:-1:flags=lanczos,palettegen=stats_mode=diff [p]; [0:v] fps=12,scale=480:-1:flags=lanczos [v]; [v][p] paletteuse=dither=bayer:bayer_scale=5", "-y", "output.gif"],
  },

  // ------------------------------------------------------------------------- Fun
  {
    id: 'echo-effect',
    group: 'Fun',
    label: 'Psychedelic echo',
    description: 'Colour trails that hang behind movement, with the hue cycling underneath.',
    suffix: 'echo',
    ext: 'mp4',
    cost: 8,
    args: ["-vf", "lagfun=decay=0.98[tmp];[tmp]hue=h=180*sin(t)", "-c:v", "libx264", "-crf", "23", "-preset", "medium", "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-r", "30", "output.mp4"],
  },
  {
    id: 'moving-window',
    group: 'Fun',
    label: 'Floating camera pan',
    description: 'A half-size viewport drifting around the frame on two slow sines.',
    suffix: 'pan',
    ext: 'mp4',
    gpu: { instead: "animating the clip's crop with keyframes" },
    reshapes: true,
    cost: MEDIUM,
    args: ["-vf", "crop=in_w/2:in_h/2:(in_w-out_w)/2+((in_w-out_w)/2)*sin(t*1.25):(in_h-out_h)/2+((in_h-out_h)/2)*sin(t*1.625)", "-c:v", "libx264", "-crf", "23", "-preset", "medium", "-movflags", "+faststart", "-pix_fmt", "yuv420p", "output.mp4"],
  },
  {
    id: 'wide-walk',
    group: 'Fun',
    label: 'Vertical squeeze',
    description: 'Reinterprets the frame as 3:1 without resampling. Everyone gets shorter.',
    suffix: 'squeezed',
    ext: 'mp4',
    gpu: { instead: "stretching the clip's placement" },
    reshapes: true,
    cost: ULTRAFAST,
    args: ["-threads", "0", "-c:a", "copy", "-vf", "setdar=3/1", "-c:v", "libx264", "-preset", "ultrafast", "output.mp4"],
  },
];

export function findPreset(id: string): ToolPreset | undefined {
  return TOOL_PRESETS.find((p) => p.id === id);
}

/** The file name the command line writes into MEMFS, read back off the end of `args`. */
export function outputName(preset: ToolPreset): string {
  return preset.args[preset.args.length - 1];
}

/** Rough wall-clock seconds for this preset on this asset. */
export function estimateSeconds(preset: ToolPreset, durationSeconds: number): number {
  return Math.max(1, preset.cost * Math.max(0, durationSeconds));
}

/**
 * The estimate as a phrase, deliberately vague at the top end.
 *
 * Rounding "about 47 minutes" to "over half an hour" is not a loss of information — the
 * input was an order-of-magnitude guess, and printing it to the minute would claim a
 * precision the number never had.
 */
export function formatEstimate(seconds: number): string {
  if (seconds < 30) return 'a few seconds';
  if (seconds < 90) return 'about a minute';
  if (seconds < 20 * 60) return `about ${Math.round(seconds / 60)} minutes`;
  if (seconds < 45 * 60) return 'over half an hour';
  if (seconds < 2 * 3600) return 'around an hour';
  return `several hours (${Math.round(seconds / 3600)} or so)`;
}

/** An excerpt of a source, in source seconds. Absent everywhere means "the whole file". */
export interface SourceRange {
  start: number;
  duration: number;
}

/** `holiday.mov` → `holiday (reversed 12.0–18.5s).mp4`. Shared by both producers. */
export function producedName(
  sourceName: string,
  suffix: string,
  ext: string,
  range?: SourceRange,
): string {
  const base = sourceName.replace(/\.[^./\\]+$/, '') || sourceName;
  const cut = range
    ? ` ${range.start.toFixed(1)}–${(range.start + range.duration).toFixed(1)}s`
    : '';
  return `${base} (${suffix}${cut}).${ext}`;
}

/** `holiday.mov` + reverse → `holiday (reversed).mp4`, or `holiday (reversed 12.0–18.5s).mp4`. */
export function derivedName(
  sourceName: string,
  preset: ToolPreset,
  range?: SourceRange,
): string {
  return producedName(sourceName, preset.suffix, preset.ext, range);
}

/** What a GPU bake calls its output. Always an excerpt — a bake is always of one clip. */
export function bakedName(sourceName: string, range: SourceRange): string {
  return producedName(sourceName, 'baked', 'mp4', range);
}

/** The `presetId` a bake records on the asset it makes. Not a member of `TOOL_PRESETS`. */
export const BAKE_ID = 'bake';

/**
 * The whole argument list for one run: the excerpt, then the recipe.
 *
 * `-ss` goes *before* `-i` so FFmpeg seeks the input rather than decoding the whole file and
 * discarding most of it, and `-t` after it caps the output. Both are frame-accurate here
 * because every one of these presets re-encodes, so there is no keyframe boundary to
 * compromise with — and the recipe that follows sees material starting at t = 0, which is
 * what the time-dependent filters (`fade`, `hue=h=180*sin(t)`, the drifting crop) need.
 *
 * `-y` is ours too. These were written for a shell, where a prompt is something you can
 * answer; in a worker it is something that never returns.
 */
export function commandLine(
  preset: ToolPreset,
  input: string,
  assetSeconds: number,
  range?: SourceRange,
): string[] {
  const sourceSeconds = range ? range.duration : assetSeconds;
  const args = preset.adapt ? preset.adapt([...preset.args], sourceSeconds) : [...preset.args];
  return [
    '-y',
    ...(range ? ['-ss', range.start.toFixed(3)] : []),
    '-i',
    input,
    ...(range ? ['-t', range.duration.toFixed(3)] : []),
    ...args,
  ];
}

/** How long the preset's output will be, for the sentence shown before the run. */
export function outputDuration(preset: ToolPreset, sourceSeconds: number): number {
  return sourceSeconds * (preset.durationScale ?? 1);
}

/**
 * Why a preset cannot take a clip's place on the timeline, or null when it can.
 *
 * A shorter or longer result is allowed through — it is a stated consequence, not an
 * error. A GIF is not: it enters the library as an image, and an image is a different kind
 * of clip from the video one it would be replacing.
 */
/**
 * Whether the result's sound stands in for the source's.
 *
 * Read off the verbatim args rather than carried as a flag, because the args are the source
 * of truth here — `-af` filters the audio, `-an` drops it, and a `durationScale` moves it in
 * time. A preset that grows an audio filter later is covered the day it is transcribed, with
 * nothing to remember to set.
 *
 * It decides one thing: whether a clip's *detached* audio has to follow it onto the new file.
 * For a picture-only preset the original file still carries the right sound, so it does not.
 */
export function presetChangesSound(preset: ToolPreset): boolean {
  return (
    preset.args.includes('-af') ||
    preset.args.includes('-an') ||
    (preset.durationScale ?? 1) !== 1
  );
}

export function replaceRefusal(preset: ToolPreset): string | null {
  if (preset.ext !== 'mp4') {
    return `A ${preset.ext.toUpperCase()} joins the library as an image, so it cannot stand in for a video clip.`;
  }
  return null;
}
