/**
 * Project, export and shader-annotation maths (phases 19, 20 and 21).
 *
 * This is the kind that fails quietly: a mask half a percent off its subject, a PiP that drifts
 * a few pixels, a preset that means something different at 4K than it does at 720p. All of it
 * looks plausible in a screenshot and is only obvious once a real project has been reshaped or
 * a real file has been uploaded. These assert the numbers directly.
 *
 *   npm run check:math
 */
import { refitRect, reframeClips, contentRect, countAnchored } from '../src/utils/reframe';
import {
  MIN_ON_SCREEN,
  clampFrame,
  clampRect,
  normalizeOverlayTransform,
  overlayTransformToPixels,
  rotatedBounds,
  rotatedOverlayBox,
  rotationOf,
} from '../src/utils/overlayTransform';
import {
  frameStageBudget,
  lockedPartner,
  lockedResize,
  stageSize,
} from '../src/utils/overlayEditorUtils';
import {
  clampVolume,
  fractionAcross,
  monitorGain,
  mutedAfterVolumeChange,
  progressFraction,
  seekTimeAt,
} from '../src/utils/transport';
import { formatClock } from '../src/utils/time';
import { clampMenuPosition, clipMenuItems } from '../src/utils/clipMenu';
import type { ClipMenuContext } from '../src/utils/clipMenu';
import {
  PANEL_MAX_FRACTION,
  PANEL_MIN_WIDTH,
  TIMELINE_MIN_HEIGHT,
  clampPanelWidth,
  clampTimelineHeight,
  resolveTab,
} from '../src/utils/panelLayout';
import { TRANSFORM_CHANNELS, transformAt } from '../src/utils/clipRender';
import { requantizeClips, summarize } from '../src/utils/requantize';
import { sameAspect, clampDimension, normalizeSettings } from '../src/utils/resolution';
import {
  DEFAULT_EXPORT_SETTINGS,
  applyQuality,
  derivedBitrate,
  resolveExport,
} from '../src/utils/exportSettings';
import {
  buildShader,
  defineParamName,
  parseShader,
  shaderControls,
} from '../src/render/effects/customShader';
import { paramDefaults } from '../src/render/effects/registry';
import { SHADER_PRESETS } from '../src/render/effects/shaderPresets';
import {
  TOOL_GROUPS,
  TOOL_PRESETS,
  commandLine,
  derivedName,
  estimateSeconds,
  findPreset,
  formatEstimate,
  outputDuration,
  outputName,
  presetChangesSound,
  replaceRefusal,
} from '../src/tools/presets';
import { bakeClipOf, bakeSize, bakeSpec } from '../src/tools/bakeClip';
import { EFFECTS } from '../src/render/effects/registry';
import { DEFAULT_EXPORT_SETTINGS as BAKE_EXPORT_DEFAULTS } from '../src/utils/exportSettings';
import { pictureInPictureTransform, PIP_MARGIN_PX, PIP_WIDTH_FRACTION } from '../src/capture/pip';
import {
  AUDIO_BITRATE_DEFAULT,
  AUDIO_BITRATE_SYSTEM,
  CAPTURE_BITRATE_CHOICES,
  KEYFRAME_SECONDS_DEFAULT,
  MIN_CAPTURE_BITRATE,
  QUALITY_SCALE,
  bitrateLabel,
  captureKeyFrameSeconds,
  captureVideoBitrate,
  estimatedBytesPerSecond,
  isQualityPreset,
  qualityLabel,
} from '../src/capture/bitrate';
import {
  REFUSE_HEADROOM_SECONDS,
  WARN_HEADROOM_SECONDS,
  budgetLevel,
  budgetOf,
  canStartRecording,
  formatBytes,
  formatHeadroom,
  headroomSeconds,
} from '../src/utils/storageBudget';
import {
  exportBlockedBy,
  offlineClipIds,
  planRelink,
  relinkSummary,
} from '../src/utils/offlineMedia';
import { fromProjectFile, toProjectFile } from '../src/project/projectFile';
import { reachableMedia } from '../src/project/rehydrate';
import { isCollectable } from '../src/project/mediaStore';
import { fastestRate, frameRateDecision } from '../src/capture/frameRate';
import { describeCameras, resolveCameraChoice } from '../src/capture/cameraDevices';
import { SOURCE_LANE, SOURCE_LABELS } from '../src/capture/recordingStore';
import {
  CAPTURE_STEP_LABELS,
  MIN_CAPTURE_EDGE,
  STALL_AFTER_MS,
  cameraFailure,
  formatLabel,
  scaledSize,
  stalledNote,
} from '../src/capture/sources';
import { settleWithin } from '../src/utils/deadline';
import {
  AUDIO_FORMATS,
  AUDIO_FORMAT_ORDER,
  audioFileName,
  audioSummary,
  estimateAudioBytes,
  pcmBytesPerSecond,
  resolveAudioExport,
} from '../src/utils/audioExport';
import {
  EMPTY_AUDIO_METADATA,
  ffmpegMetadataArgs,
  metadataFieldCount,
  metadataIsEmpty,
  parseTagDate,
  toMetadataTags,
  wavMetadataFormat,
} from '../src/utils/audioMetadata';
import { DEFAULT_EXPORT_SETTINGS, repairExportSettings } from '../src/utils/exportSettings';
import { PROJECT_FILE_VERSION } from '../src/types/editor';
import {
  detachedAudio,
  detachedAudioAdvice,
  detachedAudioOutcome,
} from '../src/utils/detachedAudio';
import {
  MIN_WINDOW_PX,
  centeredScroll,
  minimapRows,
  packBars,
  scrollForWindowX,
  timeAtMinimapX,
  viewportWindow,
} from '../src/utils/minimap';
import { buildDropClips, buildRecordingClips } from '../src/store/clipFactory';
import { createTrack, defaultTracks } from '../src/store/clipFactory';
import { readFileSync } from 'node:fs';
import type { Clip, MediaAsset } from '../src/types/editor';

let failures = 0;
function check(name: string, got: unknown, want: unknown, tol = 0.001) {
  const ok =
    typeof got === 'number' && typeof want === 'number'
      ? Math.abs(got - want) < tol
      : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}  ${typeof got === 'number' ? got.toFixed(4) : ''}`);
}

const L = { width: 1920, height: 1080 };
const V = { width: 1080, height: 1920 };

// --- 1. bottom-right PiP keeps its corner and its pixel margin ------------------
const pip = { x: (1920 - 480 - 24) / 1920, y: (1080 - 270 - 24) / 1080, w: 480 / 1920, h: 270 / 1080 };
const moved = refitRect(pip, L, V);
check('PiP right margin px', 1080 - (moved.x + moved.w) * 1080, 24, 0.5);
check('PiP bottom margin px', 1920 - (moved.y + moved.h) * 1920, 24, 0.5);
check('PiP keeps 16:9', (moved.w * 1080) / (moved.h * 1920), 16 / 9, 0.01);

// --- 2. an explicit full-frame placement becomes a centred band, not a stretch ---
const full = refitRect({ x: 0, y: 0, w: 1, h: 1 }, L, V);
check('full-frame width', full.w, 1);
check('full-frame height px', full.h * 1920, 607.5, 1);
check('full-frame centred', full.y * 1920, (1920 - 607.5) / 2, 1);

// --- 3. a mask stays on its subject when the picture moves inside the frame ------
const asset = { id: 'a', width: 1920, height: 1080 } as MediaAsset;
const masked: Clip = {
  id: 'c1', trackId: 't1', kind: 'video', assetId: 'a', timelineStart: 0,
  sourceTrimIn: 0, sourceTrimOut: 5, hasAudio: false, audioEnabled: false, gain: 1, hideVideo: false,
  effects: [{
    id: 'e1', type: 'blur', enabled: true,
    params: { 'region.mode': 1, 'region.x': 0.35, 'region.y': 0.35, 'region.w': 0.3, 'region.h': 0.3, radius: 8 },
    keyframes: { 'region.y': [{ t: 0, value: 0.35, interp: 'linear' }, { t: 2, value: 0.55, interp: 'linear' }] },
  }],
} as Clip;

const before = contentRect(L, undefined, asset);
const after = contentRect(V, undefined, asset);
const out = reframeClips([masked], { a: asset }, L, V)[0];
const p = out.effects![0].params;
// The subject sat at the centre of the picture; it must still sit at the centre of the picture.
const centreBefore = (0.35 + 0.3 / 2 - before.y) / before.h;
const centreAfter = (p['region.y'] + p['region.w'] * 0 + p['region.h'] / 2 - after.y) / after.h;
check('mask stays on subject (content-relative centre)', centreAfter, centreBefore);
check('mask x unchanged (width fills)', p['region.x'], 0.35);
check('mask height scales with picture', p['region.h'], 0.3 * (after.h / before.h));
const key0 = out.effects![0].keyframes!['region.y'][0].value;
check('mask keyframe uses the same map as the scalar', key0, p['region.y']);
check('mask keyframe count preserved', out.effects![0].keyframes!['region.y'].length, 2);

// --- 4. an untransformed, unmasked clip is not touched at all -------------------
const plain: Clip = { ...masked, id: 'c2', effects: undefined } as Clip;
check('plain clip untouched', reframeClips([plain], { a: asset }, L, V)[0] === plain, true);
check('countAnchored', countAnchored([masked, plain]), 1);

// --- 5. resolution bump is not an aspect change --------------------------------
check('854x480 is 16:9 enough', sameAspect({ width: 854, height: 480 }, L), true);
check('vertical is not', sameAspect(V, L), false);

// --- 6. frame-rate change moves edges under one frame ---------------------------
const at30: Clip = { ...plain, id: 'c3', timelineStart: 7 / 30, sourceTrimOut: 100 / 30 } as Clip;
const s = summarize([at30], 24);
check('summary counts the clip', s.clips, 1);
check('summary shift is under half a frame of 24', s.maxShift < 0.5 / 24, true);
const q = requantizeClips([at30], 24)[0];
check('start lands on a 24 fps frame', (q.timelineStart * 24) % 1, 0);
check('trim lands on a 24 fps frame', (q.sourceTrimOut * 24) % 1, 0);


// --- 7. the far end of an animated mask lands on the same subject as the near end ---
const keys = out.effects![0].keyframes!['region.y'];
const relative = (v: number, box: { y: number; h: number }) => (v - box.y) / box.h;
check(
  'mask keyframe 2 keeps its content-relative position',
  relative(keys[1].value, after),
  relative(0.55, before),
);

// --- 8. keyframe times move onto the new grid too --------------------------------
const keyed: Clip = {
  ...plain, id: 'c4',
  effects: [{ id: 'e2', type: 'blur', enabled: true, params: { radius: 4 },
    keyframes: { radius: [{ t: 0.01, value: 0, interp: "linear" }, { t: 0.02, value: 8, interp: "linear" }] } }],
} as Clip;
const qk = requantizeClips([keyed], 24)[0].effects![0].keyframes!.radius;
check('effect keyframe times land on the grid', qk.every((k) => Math.abs((k.t * 24) % 1) < 1e-9), true);
check('two keys collapsing onto one frame merge rather than duplicate', qk.length, 1);

// --- 9. dimensions are forced even, and the legacy settings shape still reads -----
check('odd width rounded to even', clampDimension(1081), 1082);
check('tiny width clamped', clampDimension(3), 16);
check('legacy preset migrates', normalizeSettings({ resolution: '1080p', fps: 25 }), { width: 1920, height: 1080, fps: 25 });
check('nonsense settings fall back', normalizeSettings(null), { width: 1920, height: 1080, fps: 30 });


// --- 10. a preset means the same thing at every frame size ----------------------
const web1080 = derivedBitrate('web', 1920, 1080, 30);
const web720 = derivedBitrate('web', 1280, 720, 30);
check('bitrate scales with pixel count', web1080 / web720, (1920 * 1080) / (1280 * 720), 0.01);
check('bitrate scales with frame rate', derivedBitrate('web', 1920, 1080, 60) / web1080, 2, 0.01);
check('master exceeds web exceeds small',
  derivedBitrate('master', 1920, 1080, 30) > web1080 && web1080 > derivedBitrate('small', 1920, 1080, 30), true);
check('a tiny frame still gets a usable stream', derivedBitrate('small', 64, 64, 24) >= 200_000, true);

// --- 11. overrides and presets do not fight ------------------------------------
const project = { width: 3840, height: 2160, fps: 30 };
const withOverride = { ...DEFAULT_EXPORT_SETTINGS, width: 1920, height: 1080 };
const resolved = resolveExport(withOverride, project);
check('override wins over the project', [resolved.width, resolved.height], [1920, 1080]);
check('override is flagged as scaled', resolved.scaled, true);
check('override keeps the project aspect', sameAspect(project, resolved), true);
check('bitrate follows the *output* size, not the project',
  resolved.videoBitrate, derivedBitrate('web', 1920, 1080, 30));

const switched = applyQuality(withOverride, 'master');
check('changing preset drops a hand-set bitrate', switched.videoBitrate, null);
check('changing preset keeps the size override', [switched.width, switched.height], [1920, 1080]);
check('changing preset moves the keyframe interval', switched.keyframeInterval, 1);

const manual = resolveExport({ ...DEFAULT_EXPORT_SETTINGS, videoBitrate: 3_000_000 }, project);
check('a hand-set bitrate is used verbatim', manual.videoBitrate, 3_000_000);

// --- 12. shader annotations ----------------------------------------------------
// The parser is the part of phase 21 that can be wrong without looking wrong: a
// mis-slotted parameter drives the wrong constant, a missed `#define` fails to compile,
// and a stage allowed to read itself would break scrubbing without any visible symptom
// until an export disagreed with the preview.
const preset = (id: string) => SHADER_PRESETS.find((p) => p.id === id)!.source;

const vhs = parseShader(preset('vhs'));
check('vhs: five sliders', vhs.params.map((p) => p.name),
  ['speed', 'displace', 'interference', 'scanPitch', 'chroma']);
check('vhs: one stage', vhs.stages.length, 1);
check('vhs: no annotation complaints', vhs.problems, []);
const vhsBuilt = buildShader(vhs, paramDefaults(shaderControls(vhs)));
check('vhs: params map to their slots in order',
  vhsBuilt.stages[0].source.includes('#define scanPitch uP[3]'), true);
check('vhs: the wrapper calls mainImage', vhsBuilt.stages[0].source.includes('mainImage(fragColor'), true);
check('vhs: channel 0 is the layer', vhs.stages[0].channels[0].source, { kind: 'input' });

const dither = parseShader(preset('dither'));
const bayer = dither.stages[0].channels.find((c) => c.index === 0)!;
check('dither: the threshold channel tiles', [bayer.wrap, bayer.filter], ['repeat', 'nearest']);
check('dither: pattern rather than an asset', bayer.source, { kind: 'pattern', pattern: 'bayer8' });
check('dither: the video is channel 1',
  dither.stages[0].channels.find((c) => c.index === 1)!.source, { kind: 'input' });
const ditherOff = buildShader(dither, { [defineParamName('GAMMA')]: 0 });
const ditherOn = buildShader(dither, { [defineParamName('GAMMA')]: 1 });
check('dither: the toggle is off by default', paramDefaults(shaderControls(dither))[defineParamName('GAMMA')], 0);
check('dither: off defines nothing', ditherOff.stages[0].source.includes('#define GAMMA'), false);
check('dither: on defines it', ditherOn.stages[0].source.includes('#define GAMMA 1'), true);
check('dither: the two variants are different programs',
  ditherOff.stages[0].key !== ditherOn.stages[0].key, true);

const ntsc = parseShader(preset('ntsc'));
check('ntsc: two stages, in order', ntsc.stages.map((s) => s.name), ['bands', 'image']);
check('ntsc: the image stage reads the earlier one',
  ntsc.stages[1].channels.find((c) => c.index === 1)!.source, { kind: 'stage', stage: 'bands' });
check('ntsc: no annotation complaints', ntsc.problems, []);
const ntscBuilt = buildShader(ntsc, paramDefaults(shaderControls(ntsc)));
const standardDefines = ntscBuilt.stages[0].source.match(/#define VIDEO_STANDARD /g) ?? [];
check('ntsc: the source own define is replaced, not duplicated', standardDefines.length, 1);
check('ntsc: the default standard is the first choice',
  ntscBuilt.stages[0].source.includes('#define VIDEO_STANDARD NTSC'), true);
check('ntsc: each stage is compiled separately',
  ntscBuilt.stages[0].source !== ntscBuilt.stages[1].source, true);
check('ntsc: the shared preamble reaches the last stage',
  ntscBuilt.stages[1].source.includes('vec4 textureBicubic'), true);

const extruded = parseShader(preset('extruded'));
check('extruded: three compile-time switches', extruded.defines.map((d) => d.name),
  ['SUBDIVIDE', 'SPARKLES', 'GRAYSCALE']);
check('extruded: defaults to half scale', extruded.defaultScale, 0.5);
check('extruded: a commented-out iMouse adds no controls', extruded.usesMouse, false);
check('extruded: switches are not animatable',
  shaderControls(extruded).filter((p) => p.fixed).length, 4);

// A stage reading itself is the one thing that would make scrubbing lie, so it is
// refused at parse time rather than producing a picture that depends on playback history.
const feedback = parseShader('// @stage a\n// @channel0 a\nvoid mainImage(out vec4 c, in vec2 p){c=vec4(0);}');
check('a stage may not sample itself', feedback.problems.length, 1);
check('the offending channel falls back to the input', feedback.stages[0].channels[0].source, { kind: 'input' });

const tooMany = parseShader(
  Array.from({ length: 9 }, (_, i) => `// @param p${i} 0 1 0.5`).join('\n') +
    '\nvoid mainImage(out vec4 c, in vec2 p){c=vec4(0);}',
);
check('the parameter cap is enforced', tooMany.params.length, 8);
check('and reported', tooMany.problems.length, 1);

const noMain = parseShader('// @name empty\nfloat f(){return 1.;}');
check('a shader with no mainImage is called out', noMain.problems.length, 1);

check('rebuilding with the same switches reuses the compiled source',
  buildShader(dither, { [defineParamName('GAMMA')]: 1 }) === ditherOn, true);

// --- 13. library presets are the source file, unchanged --------------------------
// The value of these presets is that someone got them working by running them. A filter
// chain that has been "tidied" on the way in is a different command line wearing the same
// name, so this section compares the table against `shir-effects.txt` argument by argument
// rather than trusting that nobody edited one.

const source = readFileSync('shir-effects.txt', 'utf8');
const recorded = new Map<string, string[]>();
for (const m of source.matchAll(/value:\s*"([^"]+)",\s*\n\s*args:\s*(\[[\s\S]*?\])\s*\n/g)) {
  recorded.set(m[1], JSON.parse(m[2]) as string[]);
}

check('every preset in the source file was transcribed', recorded.size, TOOL_PRESETS.length);
check('and none was invented', TOOL_PRESETS.filter((p) => !recorded.has(p.id)).length, 0);

const altered = TOOL_PRESETS.filter(
  (p) => JSON.stringify(recorded.get(p.id)) !== JSON.stringify(p.args),
).map((p) => p.id);
check('every command line is byte-identical to the source', altered, []);

check('ids are unique', new Set(TOOL_PRESETS.map((p) => p.id)).size, TOOL_PRESETS.length);
check('every group in the table is one the UI renders',
  TOOL_PRESETS.filter((p) => !TOOL_GROUPS.includes(p.group)).length, 0);
check('every group has at least one preset',
  TOOL_GROUPS.filter((g) => !TOOL_PRESETS.some((p) => p.group === g)), []);

// The runner supplies the input and the overwrite flag. A preset carrying its own would
// either read a file that is not there or open a prompt nothing can answer.
check('no preset names its own input', TOOL_PRESETS.filter((p) => p.args.includes('-i')).length, 0);
// The GIF recipe carries its own -y and is left that way; passing it twice is harmless,
// and dropping it would be an edit to a command line this file promises not to edit.
check('only the GIF recipe carries its own -y',
  TOOL_PRESETS.filter((p) => p.args.includes('-y')).map((p) => p.id), ['to-gif']);
check('the declared container matches the file the command line writes',
  TOOL_PRESETS.filter((p) => !outputName(p).endsWith(`.${p.ext}`)).length, 0);
check('the output name is the last argument',
  TOOL_PRESETS.filter((p) => /^-/.test(outputName(p))).length, 0);

// The estimate exists to stop someone starting an hour-long job by accident, which it can
// only do if the expensive ones are actually flagged.
check('anything above 20x realtime warns before it starts',
  TOOL_PRESETS.filter((p) => p.cost >= 20 && !p.slow).map((p) => p.id), []);
check('every preset has a positive cost', TOOL_PRESETS.filter((p) => !(p.cost > 0)).length, 0);

check('a minute of source through a medium re-encode', estimateSeconds(findPreset('enhance')!, 60), 360);
check('an empty clip still reads as some work', estimateSeconds(findPreset('enhance')!, 0), 1);
check('seconds stay vague', formatEstimate(12), 'a few seconds');
check('minutes are rounded', formatEstimate(9 * 60 + 20), 'about 9 minutes');
check('and the long tail stops pretending', formatEstimate(40 * 60), 'over half an hour');
check('two minutes of source through motion interpolation is an afternoon',
  formatEstimate(estimateSeconds(findPreset('convert-60fps')!, 120)), 'several hours (3 or so)');

check('the new asset is named after the old one',
  derivedName('holiday.mov', findPreset('reverse-playback')!), 'holiday (reversed).mp4');
check('only the last extension is replaced',
  derivedName('holiday.2019.final.mp4', findPreset('to-gif')!), 'holiday.2019.final (gif).gif');
check('a name with no extension keeps all of itself',
  derivedName('holiday', findPreset('black-white')!), 'holiday (b&w).mp4');
check('processing twice is visible in the name',
  derivedName(derivedName('a.mp4', findPreset('denoise')!), findPreset('sharpen')!),
  'a (denoised) (sharpened).mp4');

// The one preset whose numbers cannot be verbatim: the source fades out at a hard-coded 20s,
// which is the tail of exactly one clip length and the middle of every other.
const fade = findPreset('fade-in-out-1s')!;
const fadeAt = (seconds: number) => fade.adapt!([...fade.args], seconds).join(' ');
check('the fade-out lands one second before the end', fadeAt(10).includes('fade=t=out:st=9.000:d=1'), true);
check('and the audio fade goes with it', fadeAt(10).includes('afade=t=out:st=9.000:d=1'), true);
check('the stored args are not mutated', fade.args.join(' ').includes('st=20:d=1'), true);
check('a clip shorter than the fade clamps to zero', fadeAt(0.4).includes('fade=t=out:st=0.000:d=1'), true);
check('nothing else in the command line moved',
  fadeAt(10).replace(/st=9\.000/g, 'st=20'), fade.args.join(' '));

// --- 14. the same presets over a timeline excerpt --------------------------------
// A split leaves a clip that is two numbers on the same file, so processing "just this cut"
// is a seek and a duration on the front of an unchanged recipe. What has to hold is that the
// seek goes in front of the input (or FFmpeg decodes the whole file to throw it away), that
// the cap goes after it, and that the recipe itself is untouched by either.

const bw = findPreset('black-white')!;
const whole = commandLine(bw, 'in.mp4', 30);
check('a whole-file run is the recipe, an overwrite flag and an input',
  whole, ['-y', '-i', 'in.mp4', ...bw.args]);

const cut = commandLine(bw, 'in.mp4', 30, { start: 12.5, duration: 6.25 });
check('an excerpt seeks before the input', cut.slice(0, 4), ['-y', '-ss', '12.500', '-i']);
check('and caps after it', cut.slice(4, 7), ['in.mp4', '-t', '6.250']);
check('the recipe itself is untouched by the excerpt', cut.slice(7), bw.args);
check('an excerpt adds exactly four arguments', cut.length - whole.length, 4);

// Every preset, not just the one: a stray `-ss` inside a recipe would be shadowed by ours.
check('no recipe carries its own seek',
  TOOL_PRESETS.filter((p) => p.args.includes('-ss') || p.args.includes('-t')).map((p) => p.id), []);
check('every preset accepts an excerpt without reordering its own args',
  TOOL_PRESETS.filter((p) => {
    const built = commandLine(p, 'in.mp4', 30, { start: 1, duration: 2 });
    const expected = p.adapt ? p.adapt([...p.args], 2) : p.args;
    return JSON.stringify(built.slice(7)) !== JSON.stringify(expected);
  }).map((p) => p.id), []);

// The recipe is told the length of the cut, not of the file it was cut from — otherwise the
// one preset that reads a duration fades out somewhere in the middle of the excerpt.
const fadeCut = commandLine(fade, 'in.mp4', 300, { start: 100, duration: 8 });
check('a duration-aware preset sizes itself to the excerpt',
  fadeCut.join(' ').includes('fade=t=out:st=7.000:d=1'), true);
check('and not to the file it came from', fadeCut.join(' ').includes('st=299'), false);

// Cost follows the excerpt, which is most of why this is worth having: the expensive presets
// become affordable the moment you are only asking for the part that needs them.
check('six seconds of stabilization is not four minutes of it',
  estimateSeconds(findPreset('stabilize-deshake')!, 6), 180);
check('the same preset over the whole file',
  estimateSeconds(findPreset('stabilize-deshake')!, 240), 7200);

check('only one preset changes the length of what it is given',
  TOOL_PRESETS.filter((p) => (p.durationScale ?? 1) !== 1).map((p) => p.id), ['time-lapse']);
check('eight seconds through the time-lapse comes back as one',
  outputDuration(findPreset('time-lapse')!, 8), 1);
check('everything else comes back the length it went in',
  outputDuration(findPreset('denoise')!, 8), 8);

check('an mp4 preset may stand in for a clip', replaceRefusal(bw), null);
check('a GIF may not', typeof replaceRefusal(findPreset('to-gif')!), 'string');

check('an excerpt says so in the name it takes',
  derivedName('holiday.mov', findPreset('denoise')!, { start: 12, duration: 6.5 }),
  'holiday (denoised 12.0–18.5s).mp4');
check('a whole-file run does not', derivedName('holiday.mov', findPreset('denoise')!),
  'holiday (denoised).mp4');

// --- 15. baking on the GPU, and the presets it makes redundant -------------------
// A bake is a synthetic one-clip project handed to the exporter that already exists, so what
// has to be right is the surgery on the clip — everything describing the *picture* survives
// and everything describing the *edit* does not, because the clip that the file replaces
// still carries the edit and would otherwise apply it a second time.

const rich = {
  id: 'c1', kind: 'video', trackId: 't1', assetId: 'a1',
  timelineStart: 42, sourceTrimIn: 5, sourceTrimOut: 11,
  hasAudio: true, audioEnabled: true, gain: 0.6, hideVideo: false,
  transform: { crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, frame: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 } },
  transformKeyframes: { 'frame.x': [{ t: 0, v: 0.5, interp: 'linear' }] },
  fadeIn: 1, fadeOut: 2, transitionIn: 'dissolve',
  effects: [{ id: 'e1', type: 'sharpen', enabled: true, params: { amount: 2 },
              keyframes: { amount: [{ t: 0, v: 1, interp: 'linear' }] } }],
} as unknown as Clip;

const forBake = bakeClipOf(rich) as typeof rich;
check('a bake starts at zero', forBake.timelineStart, 0);
check('and keeps the excerpt it was cut to', [forBake.sourceTrimIn, forBake.sourceTrimOut], [5, 11]);
check('the effect chain is what is being baked', forBake.effects, rich.effects);
check('placement is not baked in', forBake.transform, undefined);
check('nor is animated placement', forBake.transformKeyframes, undefined);
check('fades stay on the clip', [forBake.fadeIn, forBake.fadeOut], [undefined, undefined]);
check('so does the transition', forBake.transitionIn, undefined);
check('and so does the clip gain', forBake.gain, 1);
check('the source is untouched', [rich.timelineStart, rich.fadeIn, rich.gain], [42, 1, 0.6]);

const bakeProject = { width: 1920, height: 1080, fps: 30 };
check('a bake is the size of its source, not of the project',
  bakeSize({ width: 1280, height: 720 } as unknown as MediaAsset, bakeProject), { width: 1280, height: 720 });
// Rounded to the nearest even rather than truncated, which is the project's own `toEven`
// everywhere else: an odd source gains a pixel column instead of losing one.
check('an odd source is forced even, which is all H.264 encodes',
  bakeSize({ width: 1281, height: 721 } as unknown as MediaAsset, bakeProject), { width: 1282, height: 722 });
check('a source with no measured size falls back to the project frame',
  bakeSize({} as unknown as MediaAsset, bakeProject), { width: 1920, height: 1080 });

const spec = bakeSpec({ width: 1280, height: 720 } as unknown as MediaAsset, bakeProject, BAKE_EXPORT_DEFAULTS);
check('the spec is sized for the bake', [spec.width, spec.height], [1280, 720]);
check('and its bitrate follows that size, not the project frame',
  spec.videoBitrate < derivedBitrate(BAKE_EXPORT_DEFAULTS.quality, 1920, 1080, spec.fps), true);
check('a bake at a different size than the project says so', spec.scaled, true);
check('and one at the same size does not',
  bakeSpec({ width: 1920, height: 1080 } as unknown as MediaAsset, bakeProject, BAKE_EXPORT_DEFAULTS).scaled,
  false);

// The redirect table is a claim about the renderer, so it is checked against the renderer.
const named = TOOL_PRESETS.filter((p) => p.gpu?.effect);
check('every effect the redirect names actually exists',
  named.filter((p) => !(p.gpu!.effect! in EFFECTS)).map((p) => p.id), []);
check('eight presets redirect to a specific effect', named.length, 8);
check('seventeen of the twenty-nine have a real-time equivalent',
  TOOL_PRESETS.filter((p) => p.gpu).length, 17);

// The other twelve are the reason FFmpeg is still here. Motion estimation, a multi-frame
// window, a feedback buffer, a pitch-preserving time stretch, a GIF encoder, and the three
// pure re-encodes whose whole point is x264's rate control rather than a filter.
check('and the rest do not pretend to',
  TOOL_PRESETS.filter((p) => !p.gpu).map((p) => p.id).sort(),
  ['convert-120fps', 'convert-60fps', 'deflicker', 'echo-effect', 'mute', 'reverse-playback',
   'rotate-90', 'stabilize-deshake', 'time-lapse', 'to-gif', 'x264-slow', 'x264-web-saas']);

// A preset that redirects still has to be runnable: the redirect is advice, not a block.
check('every redirected preset still carries its command line',
  TOOL_PRESETS.filter((p) => p.gpu && p.args.length === 0).length, 0);


// --- 16. the camera (phase 17) --------------------------------------------------
// A transform stretches the crop into the frame — the renderer does not letterbox inside
// one — so the inset's height is derived from the camera's shape, never chosen. Getting
// this wrong squashes a face by a few percent, which is exactly the kind of thing that
// looks fine in a screenshot and wrong in motion.
const pipL = pictureInPictureTransform({ width: 1280, height: 720 }, { width: 1920, height: 1080 });
check('a 16:9 camera in a 16:9 project keeps its shape',
  (pipL.frame.w * 1920) / (pipL.frame.h * 1080), 16 / 9);
check('and is a quarter of the frame wide', pipL.frame.w, PIP_WIDTH_FRACTION);
check('sitting a 24px margin from the right edge', (1 - pipL.frame.x - pipL.frame.w) * 1920, PIP_MARGIN_PX);
check('and 24px from the bottom', (1 - pipL.frame.y - pipL.frame.h) * 1080, PIP_MARGIN_PX);
check('the whole camera frame is shown — a PiP crops nothing',
  pipL.crop, { x: 0, y: 0, w: 1, h: 1 });

// The case a fixed rectangle would get wrong: same camera, portrait project.
const pipV = pictureInPictureTransform({ width: 1280, height: 720 }, { width: 1080, height: 1920 });
check('the same camera in a vertical project still keeps its shape',
  (pipV.frame.w * 1080) / (pipV.frame.h * 1920), 16 / 9);
// Two checks rather than one on a pair: these are floating-point pixels, and the point is
// that both margins are 24px, not that they serialise identically.
check('and its margin is 24px from the right in a vertical project',
  (1 - pipV.frame.x - pipV.frame.w) * 1080, PIP_MARGIN_PX);
check('and 24px from the bottom, not 24 thousandths of a taller frame',
  (1 - pipV.frame.y - pipV.frame.h) * 1920, PIP_MARGIN_PX);

const pip43 = pictureInPictureTransform({ width: 640, height: 480 }, { width: 1920, height: 1080 });
check('a 4:3 camera gets a taller box, not a stretched picture',
  (pip43.frame.w * 1920) / (pip43.frame.h * 1080), 4 / 3);
check('an unmeasured camera falls back to 16:9 rather than to the project shape',
  pictureInPictureTransform(undefined, { width: 1080, height: 1920 }).frame.h,
  pipV.frame.h);

// A tall source would otherwise run off the top of the frame.
const pipTall = pictureInPictureTransform({ width: 100, height: 900 }, { width: 1920, height: 1080 }, {
  widthFraction: 0.9,
});
check('a very tall source is shrunk to fit, both axes together',
  pipTall.frame.h <= 1 - (2 * PIP_MARGIN_PX) / 1080 + 0.0001, true);
check('and keeps its shape while being shrunk',
  (pipTall.frame.w * 1920) / (pipTall.frame.h * 1080), 100 / 900);

// Bitrate: the whole point is that the frame rate is now in the formula at all.
check('720p30 encodes at exactly what it always did', captureVideoBitrate(1280, 720, 30), 2_777_000);
check('1080p30 too', captureVideoBitrate(1920, 1080, 30), 6_000_000);
check('720p60 gets about 4 Mbps, not the 2.8 a 30 fps inset would need',
  captureVideoBitrate(1280, 720, 60), 3_927_000);
check('doubling the frame rate costs about 40% more, not 100%',
  captureVideoBitrate(1920, 1080, 60) / captureVideoBitrate(1920, 1080, 30), Math.SQRT2, 0.01);
check('a 1080p60 screen still costs more than twice a 720p60 camera',
  captureVideoBitrate(1920, 1080, 60) / captureVideoBitrate(1280, 720, 60) > 2, true);
check('a nonsense frame rate does not produce a nonsense bitrate',
  captureVideoBitrate(1280, 720, Number.NaN), captureVideoBitrate(1280, 720, 30));

// Half an hour of screen + camera is the number the panel's estimate is made of.
const perSecond = estimatedBytesPerSecond(
  [{ width: 1920, height: 1080, fps: 60 }, { width: 1280, height: 720, fps: 60 }],
  [AUDIO_BITRATE_DEFAULT, AUDIO_BITRATE_SYSTEM]);
check('1080p60 screen plus 720p60 camera for 30 minutes is under 3 GB',
  (perSecond * 1800) / 1e9 < 3, true);
check('and over 2 GB — worth saying out loud before someone starts a long take',
  (perSecond * 1800) / 1e9 > 2, true);

// Frame rate reaching the project, and the one case where it must not.
const empty = frameRateDecision(60, { fps: 30 }, 0, 30);
check('a 60 fps recording onto an empty default project moves the project', empty.fps, 60);
check('and says so', empty.notice !== null, true);
const busy = frameRateDecision(60, { fps: 30 }, 3, 30);
check('the same recording onto a project with clips changes nothing', busy.fps, null);
check('but does not stay silent about it', busy.notice !== null, true);
check('a deliberate non-default rate is left alone too',
  frameRateDecision(60, { fps: 24 }, 0, 30).fps, null);
check('a 30 fps recording onto a 30 fps project says nothing at all',
  frameRateDecision(30, { fps: 30 }, 0, 30), { fps: null, notice: null });
check('a camera reporting 29.97 does not count as faster than 30',
  frameRateDecision(29.97, { fps: 30 }, 0, 30).fps, null);
check('and one reporting 59.94 does', frameRateDecision(59.94, { fps: 30 }, 0, 30).fps, 60);
check('the fastest source is what the project would have to match',
  fastestRate([{ frameRate: 30 }, undefined, { frameRate: 60 }]), 60);
check('with no video sources at all there is nothing to match',
  fastestRate([undefined, undefined]), 0);

// Placement: the camera composites over the screen rather than beside it.
check('the camera prefers the lane above the screen',
  SOURCE_LANE.camera > SOURCE_LANE.screen, true);
check('every source kind has a label', Object.keys(SOURCE_LABELS).sort(),
  ['camera', 'mic', 'screen', 'system']);

const screenAsset = { id: 'a-screen', type: 'video', duration: 10, width: 1920, height: 1080 } as unknown as MediaAsset;
const camAsset = { id: 'a-cam', type: 'video', duration: 10, width: 1280, height: 720 } as unknown as MediaAsset;
const placed = buildRecordingClips(
  [
    { assetId: 'a-screen', asset: screenAsset, startOffset: 0, lane: SOURCE_LANE.screen },
    { assetId: 'a-cam', asset: camAsset, startOffset: 0.4, lane: SOURCE_LANE.camera,
      transform: pictureInPictureTransform({ width: 1280, height: 720 }, { width: 1920, height: 1080 }) },
  ],
  defaultTracks(), [], 0, 30,
);
check('screen and camera land on two different video tracks',
  placed.clips[0].trackId !== placed.clips[1].trackId, true);
check('a new video track was created for the camera',
  placed.tracks.filter((t) => t.kind === 'video').length, 2);
// Video tracks are stored top-to-bottom, so the camera's track being first is what
// "composites over the screen" means to the renderer.
check('and the camera is on the upper one',
  placed.tracks[0].id, placed.clips[1].trackId);
check('the camera arrives framed as a picture-in-picture',
  (placed.clips[1] as { transform?: { frame: { w: number } } }).transform?.frame.w,
  PIP_WIDTH_FRACTION);
check('the screen is not reframed', 'transform' in placed.clips[0], false);
// The measured offsets are the whole reason recordings are placed rather than imported.
check('the camera keeps the 400ms it took to open',
  placed.clips[1].timelineStart - placed.clips[0].timelineStart, 0.4);

// Devices: a picker that is usable before the permission that names the cameras.
const devices = describeCameras([
  { deviceId: 'a', kind: 'videoinput', label: '' },
  { deviceId: 'b', kind: 'videoinput', label: 'FaceTime HD' },
  { deviceId: 'm', kind: 'audioinput', label: 'Built-in Mic' },
] as unknown as MediaDeviceInfo[]);
check('microphones are not offered as cameras', devices.length, 2);
check('an unnamed camera is still selectable', devices[0].label, 'Camera 1');
check('and is marked as not yet named', [devices[0].named, devices[1].named], [false, true]);
check('a remembered camera that is still present is kept',
  resolveCameraChoice(devices, 'b'), 'b');
// Requesting a device that is gone opens some other camera while the panel shows this one.
check('a remembered camera that has been unplugged falls back to the first',
  resolveCameraChoice(devices, 'gone'), 'a');
check('with no cameras at all there is nothing to choose',
  resolveCameraChoice([], 'b'), undefined);

// The failure that sends people to the wrong settings page if it is not named.
check('a camera held by another app says so, and names the culprits',
  /in use by another application/.test(cameraFailure(new DOMException('x', 'NotReadableError'))), true);
check('a refused permission is a different sentence',
  /permission was refused/.test(cameraFailure(new DOMException('x', 'NotAllowedError'))), true);
check('an unknown failure still says what happened to the recording',
  /no camera track was recorded/.test(cameraFailure(new Error('kaboom'))), true);
check('a format is reported as negotiated, not as requested',
  formatLabel({ width: 1280, height: 720, frameRate: 30 }), '1280 × 720 · 30 fps');
check('and an unmeasured one does not invent numbers', formatLabel(null), 'format unknown');

// --- 17. the minimap (phase 18) -------------------------------------------------
//
// The strip is drawn over the same span the lanes scroll over, so every number here is
// checked against that span rather than against the project duration.

// A thirty-minute project zoomed to frame level: the case the scrub slider could not serve.
const HALF_HOUR = 1800;
const STRIP = 900;
const ZOOMED = 200;      // px per second
const LANES = 1000;      // px of visible lanes
const contentPx = HALF_HOUR * ZOOMED;

// Zoomed out until the whole project fits the lanes, the window is the whole strip.
const wide = viewportWindow(0, LANES / HALF_HOUR, LANES, HALF_HOUR, STRIP);
check('with the project fitted, the window is the whole strip', wide.w, STRIP);
check('and half a project on screen is half a strip',
  viewportWindow(0, LANES / (HALF_HOUR / 2), LANES, HALF_HOUR, STRIP).w, STRIP / 2);

const tight = viewportWindow(0, ZOOMED, LANES, HALF_HOUR, STRIP);
// 1000 of 360000 px is 2.5px of strip. A window that small cannot be grabbed.
check('a viewport too thin to grab is widened to a usable one', tight.w, MIN_WINDOW_PX);

const middle = viewportWindow(contentPx / 2, ZOOMED, LANES, HALF_HOUR, STRIP);
check('the middle of the timeline puts the window at the middle of the strip',
  middle.x, STRIP / 2);
// Dragging the window and reading it back have to be the same function inverted, or the
// window creeps away from the lanes over a long drag.
check('dragging the window to where it is leaves the scroll where it was',
  scrollForWindowX(middle.x, STRIP, HALF_HOUR, ZOOMED), contentPx / 2);

const atEnd = viewportWindow(contentPx - LANES, ZOOMED, LANES, HALF_HOUR, STRIP);
check('scrolled to the end, the window sits against the right edge, not past it',
  atEnd.x + atEnd.w, STRIP);
check('and never leaves the strip on the left', viewportWindow(-50, ZOOMED, LANES, HALF_HOUR, STRIP).x, 0);

check('a click at the far end of the strip seeks near the end of the span',
  timeAtMinimapX(STRIP, STRIP, HALF_HOUR), HALF_HOUR);
check('and a click past the strip cannot seek beyond it',
  timeAtMinimapX(STRIP + 40, STRIP, HALF_HOUR), HALF_HOUR);
// Seeking has to bring the lanes with it, centred, or the one zoom-independent control
// lands the playhead somewhere the lanes are not looking.
check('seeking centres the lanes on the destination',
  centeredScroll(HALF_HOUR / 2, ZOOMED, LANES), (HALF_HOUR / 2) * ZOOMED - LANES / 2);
check('and seeking to the start does not scroll to a negative position',
  centeredScroll(0, ZOOMED, LANES), 0);

// Sub-pixel clips. At half a pixel per second a one-second clip is invisible, and a project
// made of them would draw as empty — which is the opposite of the truth about it.
const dense = Array.from({ length: 500 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 }));
const t0 = Date.now();
const denseBars = packBars(dense, HALF_HOUR, STRIP);
const packMs = Date.now() - t0;
check('500 sub-pixel clips draw as occupied rather than as nothing', denseBars.length, 1);
check('and the run covers the span they actually occupy',
  denseBars[0].x + denseBars[0].w, 500);
check('packing 500 clips is nowhere near a frame', packMs < 16, true);

// Merging is adjacency, not "everything joins": a real gap stays a gap.
const spaced = packBars([{ start: 0, end: 1 }, { start: 100, end: 101 }], HALF_HOUR, STRIP);
check('clips with room between them stay separate', spaced.length, 2);
check('a hairline clip is still drawn at least a pixel wide', spaced[0].w, 1);
// Out-of-order clips are normal — they arrive in creation order, not timeline order.
check('bars are merged in timeline order whatever order the clips came in',
  packBars([{ start: 8, end: 9 }, { start: 0, end: 4 }, { start: 4, end: 8 }], 16, 800).length, 1);
check('nothing is drawn past the right edge',
  packBars([{ start: 15.9, end: 40 }], 16, 800)[0].w, 800 - 15.9 * 50);
check('an empty project draws no bars', packBars([], 16, 800).length, 0);

// Two rows collapsed across tracks: the strip is for recognizing a project, not editing it.
const mapTracks = [
  { id: 'v1', kind: 'video', height: 64 },
  { id: 'v2', kind: 'video', height: 64 },
  { id: 'a1', kind: 'audio', height: 48 },
] as unknown as Parameters<typeof minimapRows>[1];
const mapClip = (id: string, trackId: string, start: number, len: number) =>
  ({ id, trackId, timelineStart: start, sourceTrimIn: 0, sourceTrimOut: len }) as unknown as Clip;
const rows = minimapRows(
  [mapClip('c1', 'v1', 0, 4), mapClip('c2', 'v2', 0, 4), mapClip('c3', 'a1', 0, 4)],
  mapTracks, 16, 800,
);
check('two video tracks collapse onto one row', rows.video.length, 1);
check('and audio is read off the track, not off the clip', rows.audio.length, 1);
check('a stacked project still reads as four seconds of content', rows.video[0].w, 200);

// --- 18. detached audio follows its picture, or says why it did not ---------------
//
// `detachAudio` records no link, so the relationship is a shape. These pin the shape down,
// because the failure it guards against is silent: a processed picture over the original
// sound, with both clips individually doing exactly what they were told.

const detVideo = {
  id: 'dv', kind: 'video', trackId: 'v1', assetId: 'A',
  timelineStart: 10, sourceTrimIn: 2, sourceTrimOut: 12,
  hasAudio: true, audioEnabled: false, gain: 1, hideVideo: false,
} as unknown as Clip;
const detAudio = {
  id: 'da', kind: 'audio', trackId: 'a1', assetId: 'A',
  timelineStart: 10, sourceTrimIn: 2, sourceTrimOut: 12, gain: 1,
} as unknown as Clip;

const pair = detachedAudio(detVideo, [detVideo, detAudio]);
check('a detached audio clip is recognised without a link to follow', pair.following.length, 1);
check('and is not also counted as strayed', pair.strayed.length, 0);

// The guard: a video still playing its own sound has not been detached, whatever else is
// sitting on the audio tracks.
const playing = { ...detVideo, audioEnabled: true } as Clip;
check('a video playing its own audio has no detached partner',
  detachedAudio(playing, [playing, detAudio]).following.length, 0);
check('nor does a source file that never had audio',
  detachedAudio({ ...detVideo, hasAudio: false } as Clip, [detVideo, detAudio]).following.length, 0);

// Trimmed since: re-cutting it would throw the user's trim away, so it is left and reported.
const trimmed = { ...detAudio, sourceTrimIn: 4 } as Clip;
const strayPair = detachedAudio(detVideo, [detVideo, trimmed]);
check('an audio clip trimmed since detaching is not re-cut', strayPair.following.length, 0);
check('but it is not ignored either', strayPair.strayed.length, 1);

// A second, unrelated use of the same file elsewhere on the timeline is not this clip's.
const elsewhere = { ...detAudio, id: 'far', timelineStart: 300, sourceTrimIn: 0, sourceTrimOut: 5 } as Clip;
check('the same asset used elsewhere is left out of it',
  detachedAudio(detVideo, [detVideo, elsewhere]).strayed.length, 0);
check('and a different asset under it is not claimed',
  detachedAudio(detVideo, [detVideo, { ...detAudio, assetId: 'B' } as Clip]).following.length, 0);

// Which presets have to drag the sound with them, read off the verbatim args rather than a
// flag — so a preset that grows an `-af` later is covered the day it is transcribed.
const sounded = TOOL_PRESETS.filter(presetChangesSound).map((p) => p.id).sort();
check('exactly the presets that filter, drop or re-time the audio change the sound',
  sounded, ['fade-in-out-1s', 'mute', 'reverse-playback', 'time-lapse']);
check('a picture-only preset leaves the original audio correct',
  presetChangesSound(findPreset('sharpen')!), false);
check('and so does one that copies the audio through',
  presetChangesSound(findPreset('wide-walk')!), false);

// The sentences. Each one has to name what actually happened to the second clip.
check('following is stated, not assumed',
  /pointed at the new file with it/.test(detachedAudioOutcome(pair, true)), true);
check('not following is stated too',
  /still plays the original file/.test(detachedAudioOutcome(pair, false)), true);
check('a stray is reported even when something else followed',
  /trimmed since/.test(detachedAudioOutcome({ following: pair.following, strayed: strayPair.strayed }, true)), true);
check('a clip with no detached audio says nothing at all',
  detachedAudioOutcome({ following: [], strayed: [] }, true), '');
check('and the dialog stays quiet about it beforehand',
  detachedAudioAdvice({ following: [], strayed: [] }, true), null);
check('a sound-changing preset warns that the trimmed clip will be left behind',
  /processed picture over unprocessed sound/.test(detachedAudioAdvice(strayPair, true)!), true);
check('a picture-only preset explains why nothing needs to happen',
  /same audio either way/.test(detachedAudioAdvice(pair, false)!), true);

// --- 22. storage headroom: the number a person can act on ----------------------
//
// Bytes free is not the question anyone asks. These assert the conversion into recording
// time, and both sides of every threshold that conversion feeds.

const GB = 1024 * 1024 * 1024;
// A 1080p30 screen capture plus one AAC stream, from the project's own bitrate curve.
const RATE = estimatedBytesPerSecond([{ width: 1920, height: 1080, fps: 30 }], [AUDIO_BITRATE_DEFAULT]);

check('an hour of 1080p30 capture is a few gigabytes',
  Math.round((RATE * 3600) / GB * 10) / 10, 2.7, 0.15);
check('free space becomes seconds of recording',
  headroomSeconds(RATE * 600, RATE), 600);
// Asserted as a predicate: `check` compares numbers by difference, and Infinity - Infinity
// is NaN, so the arithmetic path cannot express "unbounded".
check('nothing being written means the space cannot run out',
  headroomSeconds(GB, 0) === Infinity, true);
check('negative free space is clamped, not negative time',
  headroomSeconds(-GB, RATE), 0);

// The thresholds, from both sides. A minute either way of the boundary must land where the
// UI says it does, because one of them disables the Record button.
check('just above the refusal line, recording may start',
  canStartRecording(RATE * (REFUSE_HEADROOM_SECONDS + 60), RATE), true);
check('just below it, it may not',
  canStartRecording(RATE * (REFUSE_HEADROOM_SECONDS - 60), RATE), false);
check('exactly at the line counts as too little',
  canStartRecording(RATE * REFUSE_HEADROOM_SECONDS, RATE), false);

const roomy = budgetOf(10 * GB, 100 * GB);
check('a mostly empty store with no capture planned is fine',
  budgetLevel(roomy), 'ok');
check('...and is still fine with twenty minutes of headroom',
  budgetLevel(roomy, WARN_HEADROOM_SECONDS + 300), 'ok');
check('fourteen minutes of headroom is a warning',
  budgetLevel(roomy, WARN_HEADROOM_SECONDS - 60), 'low');
check('four minutes is critical however much of the quota is free',
  budgetLevel(roomy, REFUSE_HEADROOM_SECONDS - 60), 'critical');
check('a nearly full store is low even with nothing being written',
  budgetLevel(budgetOf(93 * GB, 100 * GB)), 'low');
check('a 99%-full store is critical on the fraction alone',
  budgetLevel(budgetOf(99 * GB, 100 * GB)), 'critical');
check('usage cannot exceed the quota it is measured against',
  budgetOf(120 * GB, 100 * GB).free, 0);

// Rounded down and hedged: `quota` is a padded estimate and the bitrate is variable, so
// claiming a precise figure would be a precision neither input has.
check('hours and minutes', formatHeadroom(6 * 3600 + 40 * 60), 'about 6 h 40 m');
check('a whole number of hours drops the minutes', formatHeadroom(2 * 3600), 'about 2 h');
check('under an hour reads in minutes', formatHeadroom(12 * 60 + 59), 'about 12 min');
check('under a minute is not rounded to zero', formatHeadroom(41), 'under a minute');
check('no capture planned reads as no limit', formatHeadroom(Infinity), 'plenty of room');
check('bytes round the way the panel showed them', formatBytes(2.5 * GB), '2.50 GB');

// --- 23. relinking: one picker, many files ------------------------------------
//
// Imported media is never copied, so this is the path every reopened project takes. The
// matching has to be strongest-first: a folder holding two versions of the same name must
// not have them swapped by iteration order.

const offlineAssets = [
  { id: 'a1', name: 'holiday.mp4', fingerprint: { name: 'holiday.mp4', size: 1000, lastModified: 10 } },
  { id: 'a2', name: 'holiday.mp4', fingerprint: { name: 'holiday.mp4', size: 2000, lastModified: 20 } },
  { id: 'a3', name: 'music.wav', fingerprint: { name: 'music.wav', size: 300, lastModified: 30 } },
];
const offered = [
  { name: 'holiday.mp4', size: 2000, lastModified: 20 },
  { name: 'holiday.mp4', size: 1000, lastModified: 10 },
  { name: 'unrelated.mov', size: 77, lastModified: 5 },
];
const plan = planRelink(offered, offlineAssets);
check('two files of the same name find their own assets, not each other',
  plan.pairs.filter((p) => p.quality === 'exact').map((p) => [p.assetId, p.file.size]),
  [['a1', 1000], ['a2', 2000]]);
check('a file nothing wanted is reported rather than forced somewhere',
  plan.unmatched.map((f) => f.name), ['unrelated.mov']);
check('and the asset with no file offered is still offline',
  plan.stillOffline, ['a3']);

// A copy across filesystems loses `lastModified`. Same name, same size is still the file.
const copied = planRelink([{ name: 'music.wav', size: 300, lastModified: 999 }], [offlineAssets[2]]);
check('a copied file matches on name and size', copied.pairs[0].quality, 'resized');

// Name alone is accepted, because refusing would strand the user — but it is the only tier
// that can bind the wrong file, so it is reported as a guess.
const guessed = planRelink([{ name: 'music.wav', size: 999, lastModified: 1 }], [offlineAssets[2]]);
check('a differing file of the right name is a guess, not a match',
  guessed.pairs[0].quality, 'renamed');
check('and the summary says so in the words the user needs',
  /may be a different cut/.test(relinkSummary(guessed)), true);
check('a clean relink does not hedge',
  /may be a different cut/.test(relinkSummary(plan)), false);

// --- 24. offline media never reaches an encoder -------------------------------

const libOffline = {
  on: { id: 'on', name: 'here.mp4', type: 'video', duration: 5, origin: 'imported', file: {} },
  off: { id: 'off', name: 'gone.mp4', type: 'video', duration: 5, origin: 'imported' },
} as never;
const clipsFor = (assetId: string) =>
  [{ id: `c-${assetId}`, kind: 'video', assetId, trackId: 't', timelineStart: 0,
     sourceTrimIn: 0, sourceTrimOut: 5 }] as never;

check('a project whose media is all present exports',
  exportBlockedBy(clipsFor('on'), libOffline), null);
check('one offline clip stops the export and names the file',
  /gone\.mp4/.test(exportBlockedBy(clipsFor('off'), libOffline) ?? ''), true);
check('the offline clip is the one identified, not the whole timeline',
  offlineClipIds(clipsFor('off'), libOffline), ['c-off']);

// --- 25. the project file round-trips ------------------------------------------

const fixtureState = {
  settings: { width: 1920, height: 1080, fps: 30 },
  exportSettings: DEFAULT_EXPORT_SETTINGS,
  tracks: [{ id: 't1', kind: 'video', label: 'V1', height: 64, muted: false, hidden: false, locked: false }],
  clips: [
    { id: 'c1', kind: 'video', assetId: 'a1', trackId: 't1', timelineStart: 0,
      sourceTrimIn: 0, sourceTrimOut: 4, hasAudio: true, audioEnabled: true },
  ],
  libraryOrder: ['a1', 'a2'],
  mediaLibrary: {
    a1: { id: 'a1', name: 'holiday.mp4', type: 'video', duration: 12, origin: 'imported',
          fingerprint: { name: 'holiday.mp4', size: 1000, lastModified: 10 },
          file: {}, blobUrl: 'blob:x' },
    a2: { id: 'a2', name: 'holiday — Stabilized.mp4', type: 'video', duration: 12,
          origin: 'derived', opfsName: 'a2.mp4',
          derivedFrom: { assetId: 'a1', presetId: 'deshake', presetLabel: 'Stabilize' },
          file: {}, blobUrl: 'blob:y' },
  },
} as never;

const written = toProjectFile(fixtureState);
check('the live handles are not written to disk',
  JSON.stringify(written).includes('blob:'), false);
check('the saved document is exactly the undoable one',
  Object.keys(written.doc).sort(),
  ['clips', 'exportSettings', 'libraryOrder', 'settings', 'tracks']);

const readBack = fromProjectFile(JSON.parse(JSON.stringify(written)))!;
check('the document survives the round trip', readBack.doc, written.doc);
// Key *order* is not part of the format — the reader builds its own canonical order — so
// the comparison is by content. Anything that changed a value would still fail.
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]))
      : v;
check('so does the asset table', sortKeys(readBack.assets), sortKeys(written.assets));
check('a clean file needs no repairs', readBack.repairs, []);

// A version this build does not understand is not guessed at — the caller falls back to the
// rotated copy, which is the whole reason rotation exists.
check('a future version is refused rather than misread',
  fromProjectFile({ ...written, version: 99 }), null);
check('so is a file with no document at all',
  fromProjectFile({ version: 1, savedAt: 0, assets: [] }), null);

// A clip pointing at an asset the file does not describe would be invisible *and*
// unrelinkable — it could never be told what it was waiting for.
const orphaned = fromProjectFile({ ...written, assets: [written.assets[1]] })!;
check('a clip with no asset entry gets a placeholder rather than vanishing',
  orphaned.assets.some((a) => a.id === 'a1' && a.name === 'Missing file'), true);
check('and the repair is reported, not silent', orphaned.repairs.length, 1);
check('an asset missing from libraryOrder is still shown',
  fromProjectFile({ ...written, doc: { ...written.doc, libraryOrder: [] } })!.doc.libraryOrder,
  ['a1', 'a2']);

// Reachability is computed from the asset table alone and never from `derivedFrom`: a bake
// outlives the original it was made from, so deleting a source must not sweep its bytes.
check('only produced files are reachable in media/',
  [...reachableMedia(written.assets)], ['a2.mp4']);

// --- 26. the sweep cannot delete work that is merely unsaved -------------------
//
// This one is a regression test, not a precaution. "Not in the project" and "garbage" are
// only the same thing when the project on disk is current — and it is not current for a bake
// made seconds ago, or made at all in a tab that could not autosave. Sweeping on
// reachability alone deleted a bake the user had just made.

const SAVED_AT = 1_000_000;
const kept = new Set(['a2.mp4']);

check('a referenced file is never collected, however old',
  isCollectable('a2.mp4', SAVED_AT - 99_999, kept, SAVED_AT), false);
check('an unreferenced file older than the save is genuinely orphaned',
  isCollectable('gone.mp4', SAVED_AT - 1, kept, SAVED_AT), true);
check('one written after the save is unsaved work, not garbage',
  isCollectable('fresh.mp4', SAVED_AT + 1, kept, SAVED_AT), false);
check('one written in the same millisecond gets the benefit of the doubt',
  isCollectable('fresh.mp4', SAVED_AT, kept, SAVED_AT), false);


// --- 27. a drop lands where the pointer said ------------------------------------
//
// The whole difference between a drop and an import is that the position was chosen. An
// import may look for room and append; a drop may not, because the user was specific about
// the time and about nothing else. So every one of these asserts the same thing from a
// different angle: the lane may change, the time may not.

const dropTracks = [
  { ...createTrack('video', 'V2'), id: 'v2' },
  { ...createTrack('video', 'V1'), id: 'v1' },
  { ...createTrack('audio', 'A1'), id: 'a1' },
];
const videoAsset = (duration: number) =>
  ({ id: 'x', type: 'video', name: 'v.mp4', duration, hasAudio: true, origin: 'imported' }) as MediaAsset;
const audioAsset = (duration: number) =>
  ({ id: 'y', type: 'audio', name: 'a.mp3', duration, origin: 'imported' }) as MediaAsset;
const imageAsset = () =>
  ({ id: 'z', type: 'image', name: 'i.png', duration: 5, origin: 'imported' }) as MediaAsset;

const one = buildDropClips(
  [{ assetId: 'a', asset: videoAsset(4) }], dropTracks, [], 'v1', 7.5, 30);
check('a dropped clip starts where it was dropped', one.clips[0].timelineStart, 7.5);
check('on the lane it was dropped on', one.clips[0].trackId, 'v1');
check('and creates no track to do it', one.tracks.length, 3);

// Several at once: a sequence from the drop point, not a stack at it.
const three = buildDropClips(
  [
    { assetId: 'a', asset: videoAsset(4) },
    { assetId: 'b', asset: videoAsset(2) },
    { assetId: 'c', asset: imageAsset() },
  ],
  dropTracks, [], 'v1', 1, 30);
check('files dropped together queue up from the drop point',
  three.clips.map((c) => c.timelineStart), [1, 5, 7]);
check('all on the same lane', new Set(three.clips.map((c) => c.trackId)).size, 1);
check('a still gets the standard image length', three.clips[2].sourceTrimOut, 5);

// Mixed kinds do not queue behind each other — a music bed dropped with a video is meant
// to start with it, not after it.
const mixed = buildDropClips(
  [
    { assetId: 'a', asset: videoAsset(4) },
    { assetId: 'b', asset: audioAsset(30) },
  ],
  dropTracks, [], 'v1', 2, 30);
check('a video and a song dropped together both start at the pointer',
  mixed.clips.map((c) => c.timelineStart), [2, 2]);
check('the song goes to an audio lane, not the video lane it was dropped on',
  mixed.clips[1].trackId, 'a1');

// Dropped onto an occupied spot: the lane gives way, the time does not.
const occupied = [
  { id: 'c1', trackId: 'v1', timelineStart: 3, sourceTrimIn: 0, sourceTrimOut: 5,
    kind: 'video', assetId: 'old', hasAudio: false, audioEnabled: false, gain: 1, hideVideo: false },
] as Clip[];
const collided = buildDropClips(
  [{ assetId: 'a', asset: videoAsset(4) }], dropTracks, occupied, 'v1', 4, 30);
check('a drop onto an occupied spot keeps its time', collided.clips[0].timelineStart, 4);
check('and moves to the next free lane instead', collided.clips[0].trackId, 'v2');

const noRoom = buildDropClips(
  [{ assetId: 'a', asset: videoAsset(4) }],
  [{ ...createTrack('video', 'V1'), id: 'v1' }], occupied, 'v1', 4, 30);
check('with no free lane at that time, one is made', noRoom.tracks.length, 2);
check('and the time is still the time', noRoom.clips[0].timelineStart, 4);

const lockedTracks = [
  { ...createTrack('video', 'V2'), id: 'v2' },
  { ...createTrack('video', 'V1'), id: 'v1', locked: true },
];
const overLocked = buildDropClips(
  [{ assetId: 'a', asset: videoAsset(4) }], lockedTracks, [], 'v1', 6, 30);
// A sequence that had to give way stays given-way: scattering back onto the original lane
// the moment it happens to be free again is worse than one lane's worth of consistency.
const sticky = buildDropClips(
  [
    { assetId: 'a', asset: videoAsset(4) },
    { assetId: 'b', asset: videoAsset(4) },
  ],
  dropTracks, occupied, 'v1', 4, 30);
check('a bumped sequence keeps its whole length on one lane',
  [...new Set(sticky.clips.map((c) => c.trackId))], ['v2']);
check('and stays end to end', sticky.clips.map((c) => c.timelineStart), [4, 8]);

check('a locked lane is not written to', overLocked.clips[0].trackId, 'v2');
check('though the drop still happens where it was aimed',
  overLocked.clips[0].timelineStart, 6);

check('a drop before zero is clamped, not negative',
  buildDropClips([{ assetId: 'a', asset: videoAsset(4) }], dropTracks, [], 'v1', -3, 30)
    .clips[0].timelineStart, 0);
check('and lands on the frame grid like every other edit',
  buildDropClips([{ assetId: 'a', asset: videoAsset(4) }], dropTracks, [], 'v1', 1.017, 30)
    .clips[0].timelineStart, 31 / 30);


// --- 28. an overlay may hang off the edge -------------------------------------
//
// Two rects, two different rules, and they used to share one. A crop indexes into a source
// file, so outside it there are no pixels to sample; a frame says where the picture lands on
// the canvas, and hanging off the edge is a placement, not an error. The floor that used to
// apply to both is why a PiP could not slide out of shot.

const inset = { x: 0.6, y: 0.1, w: 0.3, h: 0.3 };

check('a frame pushed off the left edge stays off it',
  clampFrame({ ...inset, x: -0.2 }).x, -0.2);
check('and off the right edge too',
  clampFrame({ ...inset, x: 0.95 }).x, 0.95);
check('but never further than a tenth of itself',
  clampFrame({ ...inset, x: -5 }).x, MIN_ON_SCREEN * 0.3 - 0.3);
check('at either end', clampFrame({ ...inset, x: 5 }).x, 1 - MIN_ON_SCREEN * 0.3);
check('so something is always left to drag back',
  clampFrame({ ...inset, x: -5 }).x + 0.3 > 0, true);
check('the vertical axis reads the same rule',
  clampFrame({ ...inset, y: -0.25 }).y, -0.25);
check('a frame that fits is not touched at all', clampFrame(inset), inset);

// The crop keeps the old rule, which is the half of the split that must not move.
check('a crop is still confined to its source', clampRect({ ...inset, x: -0.2 }).x, 0);
check('on the far side as well', clampRect({ ...inset, x: 0.95 }).x, 0.7);

// The FFmpeg fallback: this is where the disagreement would have shown up, because a
// negative overlay offset used to be floored at 2 while the compositor drew it negative.
const offLeft = overlayTransformToPixels(
  { crop: { x: 0, y: 0, w: 1, h: 1 }, frame: { x: -0.1, y: 0.05, w: 0.4, h: 0.4 } },
  1280, 720, 1920, 1080);
check('the export places a hung-off frame at a negative offset', offLeft.frameX, -192);
check('and still sizes it positively', offLeft.frameW, 768);
check('a full-frame crop starts at the origin, not two pixels in', offLeft.cropX, 0);
check('and takes the whole source with it', offLeft.cropW, 1280);

// Reshaping the project must not quietly haul it back into shot.
const hungOff = refitRect({ x: -0.1, y: 0.05, w: 0.4, h: 0.4 },
  { width: 1920, height: 1080 }, { width: 1080, height: 1920 }, clampFrame);
check('reframing keeps a deliberately hung-off overlay hung off', hungOff.x < 0, true);


// --- 29. rotation, and keeping proportions ------------------------------------
//
// Rotation is placement, not an effect: it animates through the same channels, and all three
// renderers have to turn the picture the same way about the same point. The bounding box is
// the part only FFmpeg needs — `rotate` draws into a fixed size and would otherwise cut the
// corners off — and it is also the part that is easy to get subtly wrong.

check('no rotation is the default, however the field is missing', rotationOf(undefined), 0);
check('and a nonsense value is not a rotation', rotationOf({
  crop: { x: 0, y: 0, w: 1, h: 1 }, frame: { x: 0, y: 0, w: 1, h: 1 }, rotate: NaN }), 0);
check('a whole turn is not silently flattened to none — an animation may want two',
  rotationOf({ crop: { x: 0, y: 0, w: 1, h: 1 }, frame: { x: 0, y: 0, w: 1, h: 1 }, rotate: 720 }), 720);

check('an upright box needs no more room than itself', rotatedBounds(400, 200, 0), { w: 400, h: 200 });
check('a quarter turn swaps the sides', rotatedBounds(400, 200, 90).w, 200);
check('both of them', rotatedBounds(400, 200, 90).h, 400);
check('a half turn is the same box again', rotatedBounds(400, 200, 180).w, 400);
check('45 degrees needs the diagonal', rotatedBounds(400, 200, 45).w, (400 + 200) * Math.SQRT1_2);
check('and turning the other way needs exactly as much',
  rotatedBounds(400, 200, -30).w, rotatedBounds(400, 200, 30).w);

// The overlay offset re-centres the widened box on the frame's centre. Get this wrong and
// the export puts a rotated PiP somewhere the preview never had it — off by half the growth,
// down and to the right, in the encoded file only.
const upright = rotatedOverlayBox(240, 100, 768, 432, 0);
check('an unrotated layer is placed exactly where the frame is', [upright.x, upright.y], [240, 100]);
check('at exactly the frame size', [upright.w, upright.h], [768, 432]);

const quarter = rotatedOverlayBox(240, 100, 768, 432, 90);
check('a quarter turn needs the sides swapped', [quarter.w, quarter.h], [432, 768]);
check('and the box centre still lands on the frame centre',
  [quarter.x + quarter.w / 2, quarter.y + quarter.h / 2], [240 + 384, 100 + 216]);

const tilted = rotatedOverlayBox(240, 100, 768, 432, 30);
check('an awkward angle keeps its centre too',
  [tilted.x + tilted.w / 2, tilted.y + tilted.h / 2], [240 + 384, 100 + 216]);
check('the size stays even for the chroma planes', [tilted.w % 2, tilted.h % 2], [0, 0]);
check('the offset is a whole pixel and needs no rounding at all',
  [tilted.x % 1, tilted.y % 1], [0, 0]);
check('a layer turned off the left edge keeps a negative offset',
  rotatedOverlayBox(-192, 100, 768, 432, 0).x, -192);

// Normalizing keeps rotation but does not invent it, so an untouched project stays byte-identical.
const flat = normalizeOverlayTransform({ crop: { x: 0, y: 0, w: 1, h: 1 }, frame: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 } });
check('a transform with no rotation gains no rotate field', 'rotate' in flat, false);
check('rotate survives normalizing', normalizeOverlayTransform({
  crop: { x: 0, y: 0, w: 1, h: 1 }, frame: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, rotate: 30 }).rotate, 30);

check('rotation is one of the animatable placement channels',
  TRANSFORM_CHANNELS.includes('rotate'), true);

const spinning = {
  id: 'c', kind: 'video', trackId: 't', timelineStart: 10, sourceTrimIn: 0, sourceTrimOut: 4,
  assetId: 'a', hasAudio: false, audioEnabled: false, gain: 1, hideVideo: false,
  transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, frame: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, rotate: 0 },
  transformKeyframes: { rotate: [{ t: 0, value: 0, interp: 'linear' }, { t: 4, value: 180, interp: 'linear' }] },
} as unknown as Parameters<typeof transformAt>[0];
check('an animated rotation reads its start', rotationOf(transformAt(spinning, 10)), 0);
check('its midpoint', rotationOf(transformAt(spinning, 12)), 90);
check('and its end', rotationOf(transformAt(spinning, 14)), 180);
check('while the frame it turns about is left alone',
  transformAt(spinning, 12)?.frame.x, 0.1);

// Keeping proportions is measured in pixels, not in the normalized numbers: 30% by 30% is
// square only on a square canvas, and a lock that used those numbers would squash everything
// it touched on a 16:9 project.
const canvas16x9 = { w: 1920, h: 1080 };
const box = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
const grown = lockedResize(box, 0.1, 0, canvas16x9);
check('a locked resize drives from the axis the pointer moved further along', grown.w, 0.4);
check('and keeps the on-screen ratio, not the normalized one',
  (grown.w * canvas16x9.w) / (grown.h * canvas16x9.h), (box.w * canvas16x9.w) / (box.h * canvas16x9.h));
check('dragging mostly vertically drives from the height instead',
  lockedResize(box, 0.001, 0.1, canvas16x9).h, 0.4);
check('typing a width moves the height with it',
  (lockedPartner(box, 'w', 0.6, canvas16x9).h * canvas16x9.h) / (0.6 * canvas16x9.w),
  (box.h * canvas16x9.h) / (box.w * canvas16x9.w));
check('and typing a height moves the width',
  lockedPartner(box, 'h', 0.6, canvas16x9).w, 0.6);


// --- 30. panels: sizes that survive a different window, tabs that survive a selection ---
//
// Both of these fail in the same shape: a value stored on one machine, restored on another
// where it is no longer possible. A width saved on a wide display would open with both
// sidebars covering the preview; a tab saved on a video clip would be showing nothing at all
// on an audio one.

check('a dragged width is honoured', clampPanelWidth(340, 1600), 340);
check('but never thinner than a strip', clampPanelWidth(20, 1600), PANEL_MIN_WIDTH);
check('and never wide enough to swallow the preview',
  clampPanelWidth(9000, 1600), Math.round(1600 * PANEL_MAX_FRACTION));
check('a width from a wider display is brought back in',
  clampPanelWidth(700, 1200) <= Math.round(1200 * PANEL_MAX_FRACTION), true);
check('two sidebars at their maximum still leave the preview room',
  clampPanelWidth(9000, 1600) * 2 < 1600, true);
check('a corrupt stored width falls back rather than becoming NaN',
  clampPanelWidth(Number.NaN, 1600), PANEL_MIN_WIDTH);
check('a tiny window still yields a usable panel', clampPanelWidth(300, 320), PANEL_MIN_WIDTH);

check('the timeline keeps its height', clampTimelineHeight(280, 900), 280);
check('never collapses', clampTimelineHeight(10, 900), TIMELINE_MIN_HEIGHT);
check('and leaves the preview somewhere to be', clampTimelineHeight(5000, 900), 900 - 220);
check('even in a window too short for both', clampTimelineHeight(5000, 200), TIMELINE_MIN_HEIGHT);

check('a remembered tab is honoured when it is still on offer',
  resolveTab(['clip', 'placement', 'effects'], 'effects'), 'effects');
check('and falls to the first one when it is not',
  resolveTab(['clip'], 'placement'), 'clip');
check('nothing remembered means the first tab', resolveTab(['clip', 'effects'], null), 'clip');
check('and no tabs at all is null, not a crash', resolveTab([], 'clip'), null);

// The stage is why the panel needed to resize at all: it was a fixed box inside a fixed
// panel, and the bleed margin pushed it out of both.
check('the default width is the size this stage always was',
  stageSize(1920, 1080), { w: 196, h: 110 });
check('a wider panel makes a bigger stage', stageSize(1920, 1080, 400).w, 400);
check('a vertical project is capped by height, not width',
  stageSize(1080, 1920, 400).h, Math.round(400 * (176 / 196)));
check('and still keeps its shape',
  stageSize(1080, 1920, 400).w / stageSize(1080, 1920, 400).h > 0.55, true);
check('a frame stage leaves room for the bleed on both sides',
  Math.round(frameStageBudget(300) * 1.36) <= 300, true);
check('so the whole thing fits the panel it was measured against',
  frameStageBudget(300) * (1 + 0.18 * 2) <= 300, true);


// --- 31. the expanded player's transport ---------------------------------------
//
// Monitoring is not the mix. Everything here has to hold at the two ends nobody drags to on
// purpose — an empty project, a bar clicked on its last pixel — because those are where a
// scrub bar divides by zero and a clock renders a negative.

check('the slider is the gain when nothing is muted', monitorGain(0.4, false), 0.4);
check('and mute wins over whatever it was', monitorGain(0.4, true), 0);
check('raising the slider off zero unmutes', mutedAfterVolumeChange(0.3, true), false);
check('but sliding down to zero is quiet, not muted — the button stays as it was',
  mutedAfterVolumeChange(0, false), false);
check('and a muted track dragged to zero stays muted, so it un-mutes to a real volume',
  mutedAfterVolumeChange(0, true), true);
check('nonsense reads as full volume rather than silence', clampVolume(Number.NaN), 1);
check('and the slider cannot leave its rail', [clampVolume(-3), clampVolume(9)], [0, 1]);

check('the bar starts empty on an empty project', progressFraction(0, 0), 0);
check('and cannot overrun on a stale playhead', progressFraction(99, 10), 1);
check('halfway is halfway', progressFraction(5, 10), 0.5);
check('a negative playhead does not draw backwards', progressFraction(-4, 10), 0);

check('clicking the far end seeks to the end, not past it', seekTimeAt(1, 10), 10);
check('clicking the start seeks to zero', seekTimeAt(0, 10), 0);
check('an empty project has nowhere to seek to', seekTimeAt(0.5, 0), 0);

const bar = { left: 100, width: 400 };
check('the middle of the bar is the middle', fractionAcross(300, bar), 0.5);
check('the last pixel is the end, not slightly past it', fractionAcross(9999, bar), 1);
check('and dragging off the left edge is the start', fractionAcross(-50, bar), 0);
check('a bar with no width yet does not divide by zero',
  fractionAcross(300, { left: 0, width: 0 }), 0);

// The simplified clock: what you want while watching, not while cutting.
check('under a minute', formatClock(9), '0:09');
check('minutes and seconds', formatClock(75), '1:15');
check('an hour brings the hours out', formatClock(3661), '1:01:01');
check('and it never shows a negative', formatClock(-5), '0:00');
check('a frame short of a second has not got there yet', formatClock(0.98), '0:00');


// --- 32. the clip context menu -------------------------------------------------
//
// A menu is mostly a list of things that must not be offered. An action shown on a clip it
// cannot work on is worse than one that is missing — you click it and nothing happens, or
// worse, something does. Every entry below is either absent or disabled *with a reason*.

const menuBase: ClipMenuContext = {
  kind: 'video', playheadInside: true, hasAsset: true, offline: false,
  hasAudio: true, audioEnabled: true, hideVideo: false,
  trackLocked: false, producerBusy: false, selectionCount: 1,
};
const ids = (ctx: ClipMenuContext) => clipMenuItems(ctx).map((i) => i.id);
const item = (ctx: ClipMenuContext, id: string) => clipMenuItems(ctx).find((i) => i.id === id);
const enabled = (ctx: ClipMenuContext, id: string) => item(ctx, id)?.disabled !== true;

check('a video clip offers the lot',
  ids(menuBase),
  ['split', 'trimStart', 'trimEnd', 'duplicate', 'bake', 'preset', 'detach', 'toggleAudio',
   'toggleVideo', 'zoom', 'delete', 'rippleDelete']);

// An audio clip has no picture to bake, no preset to run over it and no audio to detach from
// itself — and no mute, because a gain of zero cannot say what it used to be.
check('an audio clip offers only what an audio clip has',
  ids({ ...menuBase, kind: 'audio', hideVideo: false }),
  ['split', 'trimStart', 'trimEnd', 'duplicate', 'zoom', 'delete', 'rippleDelete']);
check('a text clip has no source to render from',
  ids({ ...menuBase, kind: 'text' }).includes('bake'), false);
check('an image can be baked but has no preset',
  [ids({ ...menuBase, kind: 'image' }).includes('bake'),
   ids({ ...menuBase, kind: 'image' }).includes('preset')], [true, false]);

check('splitting needs the playhead inside the clip',
  enabled({ ...menuBase, playheadInside: false }, 'split'), false);
check('and says so rather than greying out silently',
  !!item({ ...menuBase, playheadInside: false }, 'split')?.reason, true);
check('trimming to the playhead needs it too',
  enabled({ ...menuBase, playheadInside: false }, 'trimEnd'), false);

check('a locked track disables every edit',
  ['split', 'trimStart', 'trimEnd', 'duplicate', 'delete', 'rippleDelete']
    .every((id) => !enabled({ ...menuBase, trackLocked: true }, id)), true);
check('but zooming to it is still allowed — looking is not editing',
  enabled({ ...menuBase, trackLocked: true }, 'zoom'), true);

check('offline media cannot be baked', enabled({ ...menuBase, offline: true }, 'bake'), false);
check('and the reason names relinking',
  item({ ...menuBase, offline: true }, 'bake')?.reason?.includes('relink'), true);
check('one producer at a time', enabled({ ...menuBase, producerBusy: true }, 'preset'), false);
check('a file with no audio track cannot have it detached',
  enabled({ ...menuBase, hasAudio: false }, 'detach'), false);

check('the labels count what is actually selected',
  item({ ...menuBase, selectionCount: 3 }, 'delete')?.label, 'Delete 3 clips');
check('and stay singular for one', item(menuBase, 'delete')?.label, 'Delete');
check('the toggles say what the click will do',
  [item(menuBase, 'toggleVideo')?.label,
   item({ ...menuBase, hideVideo: true }, 'toggleVideo')?.label],
  ['Hide video', 'Show video']);

// The timeline sits at the bottom of the window, so a menu opening downwards off the screen
// is not an edge case here — it is every right-click.
const view = { width: 1200, height: 800 };
const menuBox = { width: 240, height: 300 };
check('a menu with room opens where you clicked',
  clampMenuPosition(100, 100, menuBox, view), { x: 100, y: 100 });
check('one near the bottom flips up over the pointer',
  clampMenuPosition(100, 700, menuBox, view).y, 400);
check('one near the right edge flips left',
  clampMenuPosition(1100, 100, menuBox, view).x, 860);
check('and a corner does both',
  clampMenuPosition(1100, 700, menuBox, view), { x: 860, y: 400 });
check('a menu taller than the window still starts on screen',
  clampMenuPosition(100, 700, { width: 240, height: 900 }, view).y >= 0, true);


// --- 33. what a recording costs, and what the panel says it costs ---------------
//
// The estimate is the number someone decides on before there is any file to measure, so it
// has to be priced at what the encoder will actually be told — the rate the capture will
// *request*, and the bitrate each audio stream will really use. Reading the project's frame
// rate instead priced a 60 fps screen capture at half its cost, and the figure only corrected
// itself once the take was running, which is after it could change anyone's mind.

check('Normal is exactly what every recording used before the setting existed',
  QUALITY_SCALE.normal, 1);
check('so Normal at 1080p30 is still 6 Mbps',
  captureVideoBitrate(1920, 1080, 30, 'normal'), 6_000_000);
check('Draft is meaningfully smaller', captureVideoBitrate(1920, 1080, 30, 'draft'), 3_600_000);
check('High is meaningfully bigger', captureVideoBitrate(1920, 1080, 30, 'high'), 9_600_000);
check('and an unspecified quality is Normal',
  captureVideoBitrate(1920, 1080, 30), captureVideoBitrate(1920, 1080, 30, 'normal'));

// The frame rate still enters as a square root, quality on top of it rather than instead.
check('60 fps costs about 40% more, not 100%',
  captureVideoBitrate(1920, 1080, 60, 'normal') / 6_000_000, Math.SQRT2, 0.01);
check('and quality scales that too',
  captureVideoBitrate(1920, 1080, 60, 'draft'),
  Math.round((captureVideoBitrate(1920, 1080, 60, 'normal') * 0.6) / 1000) * 1000);

// The reported bug: screen + mic + system audio on a 1080p project.
const hd = [{ width: 1920, height: 1080, fps: 30 }];
const bothAudio = [AUDIO_BITRATE_DEFAULT, AUDIO_BITRATE_SYSTEM];
check('system audio is charged at what system audio costs',
  estimatedBytesPerSecond(hd, bothAudio) * 8, 6_000_000 + 192_000 + 256_000);
check('a count-and-a-default was 64 kbps light on exactly this setup',
  estimatedBytesPerSecond(hd, bothAudio) - estimatedBytesPerSecond(hd, [192_000, 192_000]),
  64_000 / 8);

// The one that was actually wrong by 41%.
const priced30 = estimatedBytesPerSecond([{ width: 1920, height: 1080, fps: 30 }], bothAudio);
const priced60 = estimatedBytesPerSecond([{ width: 1920, height: 1080, fps: 60 }], bothAudio);
check('pricing a 60 fps capture at 30 understated it by more than a third',
  priced60 / priced30 > 1.35, true);
check('draft at 60 fits in less than normal at 60',
  estimatedBytesPerSecond([{ width: 1920, height: 1080, fps: 60 }], bothAudio, 'draft') < priced60, true);
check('an audio-only take costs only its audio',
  estimatedBytesPerSecond([], [AUDIO_BITRATE_DEFAULT]) * 8, 192_000);

check('the format label is the shape people recognise', qualityLabel(1080, 60), '1080p60');
check('and reads the same for a camera', qualityLabel(720, 30), '720p30');
check('a rate that never arrived is left off', qualityLabel(1080, 0), '1080p');
check('and nothing at all says so', qualityLabel(0, 60), 'unknown format');


// --- 34. recording scale --------------------------------------------------------
//
// Scale rather than resolution, because for a screen capture the resolution is not ours to
// pick: the share picker decides, and a program window is whatever size it was left. The
// rules that matter are the ones that fire on the sizes nobody plans for — an odd-numbered
// window, and a small one asked to halve twice.

check('full scale leaves a source exactly alone', scaledSize(1920, 1080, 1), { width: 1920, height: 1080 });
check('half of 1080p is 540p', scaledSize(1920, 1080, 0.5), { width: 960, height: 540 });
check('a quarter of 4K is still a full HD frame',
  scaledSize(3840, 2160, 0.25), { width: 960, height: 540 });
check('three quarters of 1080p', scaledSize(1920, 1080, 0.75), { width: 1440, height: 810 });

// An application window is the case this setting exists for, and it is never a round number.
check('an odd-sized window comes out even on both axes',
  scaledSize(1001, 701, 0.5), { width: 500, height: 350 });
check('and keeps its shape while doing it',
  Math.abs(500 / 350 - 1001 / 701) < 0.01, true);
check('an odd scale of an odd window is still even',
  [scaledSize(1063, 745, 0.75).width % 2, scaledSize(1063, 745, 0.75).height % 2], [0, 0]);

// Refusals. Every one of these returns the source untouched rather than a broken frame size.
check('a scale that would go under the floor is refused outright',
  scaledSize(400, 300, 0.25), { width: 400, height: 300 });
check('and it is the *shorter* edge that decides',
  scaledSize(1920, 200, 0.5), { width: 1920, height: 200 });
check('the floor is where it says it is',
  scaledSize(MIN_CAPTURE_EDGE * 2, MIN_CAPTURE_EDGE * 2, 0.5),
  { width: MIN_CAPTURE_EDGE, height: MIN_CAPTURE_EDGE });
check('scaling up is not this control’s job', scaledSize(640, 480, 2), { width: 640, height: 480 });
check('nor is scaling to nothing', scaledSize(640, 480, 0), { width: 640, height: 480 });
check('a nonsense scale changes nothing', scaledSize(640, 480, Number.NaN), { width: 640, height: 480 });
check('and neither does an unmeasured track', scaledSize(0, 0, 0.5), { width: 0, height: 0 });

// The point of the setting: half the edges is a quarter of the pixels, and the bitrate
// curve follows the pixel count — so half scale is roughly a quarter of the bytes.
const fullScale = captureVideoBitrate(1920, 1080, 60, 'normal');
const halfScale = captureVideoBitrate(960, 540, 60, 'normal');
check('half scale costs about a quarter as much', fullScale / halfScale, 4, 0.3);
check('and half scale on Draft is cheaper still',
  captureVideoBitrate(960, 540, 60, 'draft') < halfScale, true);


// --- 35. A bitrate said outright, for the hour-long call ------------------------------
// The presets multiply a curve; this is the escape from it. The two rules that matter are
// that a fixed rate really is fixed — it must not move when the share picker hands back a
// different window — and that everything at or above Draft encodes exactly as it did
// before the setting existed.
check('a fixed rate is used as said', captureVideoBitrate(1920, 1080, 60, 600_000), 600_000);
check('and does not move with the picture',
  captureVideoBitrate(640, 360, 30, 600_000), captureVideoBitrate(3840, 2160, 60, 600_000));
check('nor with the frame rate',
  captureVideoBitrate(1920, 1080, 24, 1_000_000), captureVideoBitrate(1920, 1080, 60, 1_000_000));
check('the presets are untouched by any of this',
  captureVideoBitrate(1920, 1080, 30, 'normal'), 6_000_000);
check('a rate below the floor is lifted to it',
  captureVideoBitrate(1920, 1080, 30, 30_000), MIN_CAPTURE_BITRATE);
check('and a nonsense one does not produce a nonsense encode',
  captureVideoBitrate(1920, 1080, 30, Number.NaN) > MIN_CAPTURE_BITRATE, true);

// The whole reason for the control: what an hour of a call costs at each end of the dial.
const callSources = [{ width: 1920, height: 1080, fps: 30 }];
const callAudio = [AUDIO_BITRATE_DEFAULT, AUDIO_BITRATE_SYSTEM];
const hourAtNormal = estimatedBytesPerSecond(callSources, callAudio, 'normal') * 3600;
const hourAtLow = estimatedBytesPerSecond(callSources, callAudio, 600_000) * 3600;
check('an hour at Normal is the 2.9 GB that started this', hourAtNormal / 1e9, 2.9, 0.1);
check('and 600 kbps brings the same hour under half a gigabyte', hourAtLow / 1e9 < 0.5, true);
check('the audio is what is left, and is not reduced with it',
  estimatedBytesPerSecond([], callAudio), estimatedBytesPerSecond([], callAudio, 300_000));

// Labels: one dial, two kinds of answer, and the reader must be able to tell which is which.
check('a preset reads as its name', bitrateLabel('draft'), 'Draft');
check('a round rate reads in megabits', bitrateLabel(2_000_000), '2 Mbps');
check('an unround one keeps a decimal', bitrateLabel(1_500_000), '1.5 Mbps');
check('and a small one reads in kilobits', bitrateLabel(600_000), '600 kbps');
check('every choice on the dial has a label',
  CAPTURE_BITRATE_CHOICES.every((b) => bitrateLabel(b).length > 0), true);
check('the presets come first', CAPTURE_BITRATE_CHOICES.findIndex((b) => !isQualityPreset(b)), 3);
check('and the fixed rates descend',
  CAPTURE_BITRATE_CHOICES.filter((b) => !isQualityPreset(b)) as number[],
  [4_000_000, 2_000_000, 1_000_000, 600_000, 300_000]);

// Key frames. A fragmented MP4 closes a fragment only on a key frame, so this interval is
// the crash window and the seek grid as well as a cost — which is why it is derived from
// the rate rather than offered as a fourth control, and why anything that was already
// affordable keeps the one second it always had.
check('Normal keeps its one-second key frames',
  captureKeyFrameSeconds(1920, 1080, 30, 'normal'), KEYFRAME_SECONDS_DEFAULT);
check('so does Draft', captureKeyFrameSeconds(1920, 1080, 30, 'draft'), KEYFRAME_SECONDS_DEFAULT);
check('and so does High', captureKeyFrameSeconds(1920, 1080, 30, 'high'), KEYFRAME_SECONDS_DEFAULT);
check('a rate at half the curve is still affordable',
  captureKeyFrameSeconds(1920, 1080, 30, 3_000_000), KEYFRAME_SECONDS_DEFAULT);
check('a quarter of it widens to two seconds',
  captureKeyFrameSeconds(1920, 1080, 30, 2_000_000), 2);
check('and the bottom of the dial to four',
  captureKeyFrameSeconds(1920, 1080, 30, 300_000), 4);
// The same absolute rate is generous for a small picture and mean for a large one, so the
// interval follows the ratio rather than the number.
check('600 kbps is not a low rate for a 360p camera',
  captureKeyFrameSeconds(640, 360, 30, 600_000), KEYFRAME_SECONDS_DEFAULT);
check('but it is for a 1080p screen', captureKeyFrameSeconds(1920, 1080, 30, 600_000), 4);
check('the interval never exceeds four seconds',
  captureKeyFrameSeconds(3840, 2160, 60, MIN_CAPTURE_BITRATE), 4);


// --- 36. A start that waits forever ---------------------------------------------------
// Starting a take is a chain of awaits on things outside the page, and every one of them can
// sit there without ever rejecting. `ChunkSink` already grew a deadline for this reason; the
// rest of the chain had none, which is how "Waiting for you to choose a screen, window or
// tab…" became a sentence that could outlive the picker it described.

// A wait with a defined fallback is given up on rather than escaped.
const never = new Promise<number>(() => undefined);
check('a promise that never settles is abandoned', await settleWithin(never, 20), { ok: false });
check('a value that arrives in time comes back',
  await settleWithin(Promise.resolve(7), 1000), { ok: true, value: 7 });
check('a rejection reads the same as a timeout — both mean carry on without it',
  await settleWithin(Promise.reject(new Error('no')), 1000), { ok: false });
check('and the deadline does not delay a promise that already settled',
  await settleWithin(Promise.resolve('x'), 60_000), { ok: true, value: 'x' });

// A wait only the user can end gets a sentence and a Cancel button, not a deadline: there is
// no honest timeout for how long someone should take to choose a window.
check('a step that is progressing is not accused of hanging',
  stalledNote('screen-picker', STALL_AFTER_MS - 1), null);
check('and neither is one that has not started', stalledNote(null, 60_000), null);
check('a picker that never came back says so, and says what to press',
  (stalledNote('screen-picker', STALL_AFTER_MS) ?? '').includes('Cancel'), true);
check('a prompt that was never answered points at the prompt',
  (stalledNote('microphone', STALL_AFTER_MS) ?? '').includes('permission prompt'), true);
check('the camera says the same thing as the microphone',
  stalledNote('camera', STALL_AFTER_MS), stalledNote('microphone', STALL_AFTER_MS));
check('a resize that hangs promises the recording anyway',
  (stalledNote('sizing', STALL_AFTER_MS) ?? '').includes('its own size'), true);
check('and every other step still has something to say',
  (stalledNote('opening-files', STALL_AFTER_MS) ?? '').length > 0, true);
check('nothing has been recorded when any of these fire',
  (stalledNote('starting-encoders', STALL_AFTER_MS) ?? '').includes('nothing has been recorded'), true);

// The resize now has a step of its own. Without one it happened inside 'screen-picker', so a
// track that never answered left the panel blaming a picker the user had already dealt with.
check('the resize is a step you can see', typeof CAPTURE_STEP_LABELS.sizing, 'string');
check('every step has a label',
  Object.values(CAPTURE_STEP_LABELS).every((label) => label.length > 0), true);


// --- 37. audio export: formats, sizes, names, tags -------------------------------
// An audio-only export is the mix in a different container. What can go wrong is not the
// audio — that is the same generator the video export uses — but everything around it: a
// bitrate handed to a format that has none, an .mp4 extension on a file with no picture,
// an empty ID3 frame where the user typed nothing.

// Every format must be distinguishable from every other, or the download name and the muxer
// disagree about what was written.
const audioExtensions = AUDIO_FORMAT_ORDER.map((f) => AUDIO_FORMATS[f].extension);
check('every audio format has its own extension',
  new Set(audioExtensions).size, AUDIO_FORMAT_ORDER.length);
check('every audio format has a codec',
  AUDIO_FORMAT_ORDER.every((f) => AUDIO_FORMATS[f].codec.length > 0), true);
check('every audio format says what it is for',
  AUDIO_FORMAT_ORDER.every((f) => AUDIO_FORMATS[f].description.length > 0), true);
// Mediabunny's Mp4OutputFormat reports '.mp4'. A .mp4 with no video track reads as a broken
// video to phones and players, which is why this one is overridden.
check('AAC audio is named .m4a, not .mp4', AUDIO_FORMATS.m4a.extension, '.m4a');
check('only WAV and FLAC are lossless',
  AUDIO_FORMAT_ORDER.filter((f) => AUDIO_FORMATS[f].lossless), ['wav', 'flac']);
check('lossless formats offer no bitrate choice',
  AUDIO_FORMAT_ORDER.every((f) => AUDIO_FORMATS[f].lossless === (AUDIO_FORMATS[f].bitrates === null)),
  true);

const audioSettings = { ...DEFAULT_EXPORT_SETTINGS, output: 'audio' as const, audioBitrate: 192_000 };
const mp3Spec = resolveAudioExport(audioSettings);
check('a lossy format carries the bitrate through', mp3Spec.bitrate, 192_000);
check('and its codec', mp3Spec.codec, 'mp3');
// Zero rather than the leftover 192_000: nothing downstream can then pass a meaningless
// bitrate to an encoder that would honour it. Mediabunny rejects a bitrate for PCM outright.
const wavSpec = resolveAudioExport({ ...audioSettings, audioFormat: 'wav' });
check('a lossless format reports no bitrate at all', wavSpec.bitrate, 0);
check('a lossless format is marked lossless', wavSpec.lossless, true);

check('PCM bytes per second, 48k stereo 16-bit', pcmBytesPerSecond(48_000, 2), 192_000);
check('PCM bytes per second, mono halves it', pcmBytesPerSecond(48_000, 1), 96_000);
// An hour of these is the case this feature exists for, and the difference between them is
// the whole reason the format choice is the first control in the dialog.
check('an hour of 192 kbps MP3', estimateAudioBytes(mp3Spec, 3600), 86_400_000);
check('an hour of 48k stereo WAV', estimateAudioBytes(wavSpec, 3600), 691_200_044);
check('FLAC is estimated at 0.6 of PCM',
  estimateAudioBytes(resolveAudioExport({ ...audioSettings, audioFormat: 'flac' }), 3600),
  Math.round(691_200_000 * 0.6));
check('a mono MP3 is the same size as a stereo one — the bitrate is the bitrate',
  estimateAudioBytes(resolveAudioExport({ ...audioSettings, audioChannels: 1 }), 60),
  estimateAudioBytes(mp3Spec, 60));

check('a typed title becomes the file name',
  audioFileName('Team sync', mp3Spec, 1000), 'Team sync.mp3');
check('and loses what a file system objects to',
  audioFileName('Q3: plans / notes', mp3Spec, 1000), 'Q3 plans notes.mp3');
// Checked after cleaning rather than before: a title that is entirely punctuation leaves
// nothing behind, and an empty name is not a name.
check('a title of nothing but punctuation falls back to the timestamp',
  audioFileName('///', mp3Spec, 1000), 'export_1000.mp3');
check('no title at all falls back too',
  audioFileName('   ', wavSpec, 1000), 'export_1000.wav');
check('the extension follows the format',
  audioFileName('Take', resolveAudioExport({ ...audioSettings, audioFormat: 'ogg' }), 1), 'Take.ogg');

check('the toolbar says the rate for a lossy format', audioSummary(mp3Spec), 'MP3 · 192 kbps');
check('and the sample rate for a lossless one', audioSummary(wavSpec), 'WAV · 48 kHz');

// --- tags ---------------------------------------------------------------------
check('an untouched form is empty', metadataIsEmpty(EMPTY_AUDIO_METADATA), true);
check('and writes no tags at all',
  Object.keys(toMetadataTags(EMPTY_AUDIO_METADATA)).length, 0);
// An empty ID3 frame is not the same as no frame: players show it as a title of one space,
// and taggers preserve it. Whatever was not filled in must leave no trace.
check('blank fields are absent, not written empty',
  Object.keys(toMetadataTags({ ...EMPTY_AUDIO_METADATA, title: '   ', artist: 'Ann' })),
  ['artist']);
check('and are trimmed when they are not blank',
  toMetadataTags({ ...EMPTY_AUDIO_METADATA, title: '  Take one  ' }).title, 'Take one');

const fullTags = toMetadataTags({
  ...EMPTY_AUDIO_METADATA,
  title: 'Take one',
  artist: 'Ann',
  album: 'Calls',
  albumArtist: 'Various',
  trackNumber: 3,
  tracksTotal: 12,
  date: '2026-08-25',
});
check('the tags that were typed are all there',
  Object.keys(fullTags).sort(),
  ['album', 'albumArtist', 'artist', 'date', 'title', 'trackNumber', 'tracksTotal']);
check('track numbers stay numbers', fullTags.trackNumber, 3);

// `new Date('2026-08-25')` is UTC midnight, which anywhere west of Greenwich is the day
// before — the tag would read the 24th for everyone in the Americas.
const tagDate = parseTagDate('2026-08-25');
check('a typed date is the date that was typed, in any timezone',
  [tagDate?.getFullYear(), (tagDate?.getMonth() ?? -1) + 1, tagDate?.getDate()],
  [2026, 8, 25]);
check('a half-typed date is no date', parseTagDate('2026-08'), null);
check('and neither is nothing', parseTagDate(''), null);

check('a cover image becomes one front-cover attachment',
  toMetadataTags({ ...EMPTY_AUDIO_METADATA, coverAssetId: 'a1' },
    { data: new Uint8Array([1, 2]), mimeType: 'image/png' }).images?.[0].kind,
  'coverFront');

// FFmpeg's key names are its own, and they differ in exactly the places that matter.
check('FFmpeg gets flag/value pairs',
  ffmpegMetadataArgs({ ...EMPTY_AUDIO_METADATA, artist: 'Ann' }), ['-metadata', 'artist=Ann']);
check('album artist is one word to FFmpeg',
  ffmpegMetadataArgs({ ...EMPTY_AUDIO_METADATA, albumArtist: 'Various' }),
  ['-metadata', 'album_artist=Various']);
check('a track with a total is written the conventional way',
  ffmpegMetadataArgs({ ...EMPTY_AUDIO_METADATA, trackNumber: 3, tracksTotal: 12 }),
  ['-metadata', 'track=3/12']);
check('and without one it is just the number',
  ffmpegMetadataArgs({ ...EMPTY_AUDIO_METADATA, trackNumber: 3 }), ['-metadata', 'track=3']);
check('a total on its own says nothing and is dropped',
  ffmpegMetadataArgs({ ...EMPTY_AUDIO_METADATA, tracksTotal: 12 }), []);
check('an unparseable date is not passed on',
  ffmpegMetadataArgs({ ...EMPTY_AUDIO_METADATA, date: 'last tuesday' }), []);

// A RIFF INFO list is what other editors read, but it cannot hold artwork or lyrics.
check('a plain WAV keeps its tags where DAWs look',
  wavMetadataFormat({ ...EMPTY_AUDIO_METADATA, title: 'Take' }), 'info');
check('artwork moves them to an ID3 chunk',
  wavMetadataFormat({ ...EMPTY_AUDIO_METADATA, coverAssetId: 'a1' }), 'id3');
check('so do lyrics', wavMetadataFormat({ ...EMPTY_AUDIO_METADATA, lyrics: 'la' }), 'id3');

check('the disclosure counts what is filled in',
  metadataFieldCount({ ...EMPTY_AUDIO_METADATA, title: 'A', artist: 'B', trackNumber: 1 }), 3);
check('whitespace is not a filled-in field',
  metadataFieldCount({ ...EMPTY_AUDIO_METADATA, title: '   ' }), 0);

// --- an older project file ------------------------------------------------------
// The project file is read back with a cast, not a schema, so every field added to
// ExportSettings since the format was frozen arrives as undefined in a project written
// before it. Merging the defaults underneath fixes this addition and the next one.
const oldSettings = repairExportSettings({ quality: 'small', videoBitrate: null, audioChannels: 1 });
check('an older project gets a working audio format', oldSettings.audioFormat, DEFAULT_EXPORT_SETTINGS.audioFormat);
check('and a sample rate', oldSettings.audioSampleRate, DEFAULT_EXPORT_SETTINGS.audioSampleRate);
check('and still exports video, as it always did', oldSettings.output, 'video');
check('what it did say is kept', oldSettings.quality, 'small');
check('including a channel count', oldSettings.audioChannels, 1);
// null is a real answer for the override fields — "follow the project" — so only undefined falls back.
check('an explicit null override is not overwritten by a default',
  repairExportSettings({ width: null }).width, null);
check('nonsense in that slot yields the defaults whole',
  repairExportSettings('not an object'), DEFAULT_EXPORT_SETTINGS);

// These three are used as lookup keys, so an unrecognised one would throw on a property of
// undefined rather than degrade. A hand-edited file, or one from a build that had a format
// this one does not, must still open.
check('an unknown audio format falls back to a known one',
  repairExportSettings({ audioFormat: 'aiff' }).audioFormat, DEFAULT_EXPORT_SETTINGS.audioFormat);
check('an unknown output falls back to video',
  repairExportSettings({ output: 'gif' }).output, 'video');
check('an unknown quality falls back to the default preset',
  repairExportSettings({ quality: 'ultra' }).quality, DEFAULT_EXPORT_SETTINGS.quality);
check('the format table has a row for every name the repair allows',
  AUDIO_FORMAT_ORDER.every((f) => repairExportSettings({ audioFormat: f }).audioFormat === f), true);

const oldFile = fromProjectFile({
  version: PROJECT_FILE_VERSION,
  savedAt: 1,
  doc: {
    settings: { width: 1920, height: 1080, fps: 30 },
    exportSettings: { quality: 'web' },
    tracks: [],
    clips: [],
    libraryOrder: [],
  },
  assets: [],
});
check('a project file missing the new fields still loads',
  oldFile?.doc.exportSettings.audioFormat, DEFAULT_EXPORT_SETTINGS.audioFormat);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
