/**
 * What a right-click on a clip offers, and why each entry is or is not available.
 *
 * Kept apart from the component because this is the part that gets quietly wrong: an action
 * offered on a clip it cannot work on is worse than one that is missing, and "greyed out with
 * a reason" is worth more than either. The component turns ids into store calls and nothing
 * else.
 */

export type ClipMenuId =
  | 'split'
  | 'trimStart'
  | 'trimEnd'
  | 'duplicate'
  | 'bake'
  | 'preset'
  | 'detach'
  | 'toggleAudio'
  | 'toggleVideo'
  | 'zoom'
  | 'delete'
  | 'rippleDelete';

export interface ClipMenuItem {
  id: ClipMenuId;
  label: string;
  /** Shown right-aligned. The same key the timeline already listens for. */
  accel?: string;
  disabled?: boolean;
  /** Why it is disabled, as a tooltip. Never a silent grey. */
  reason?: string;
  danger?: boolean;
  /** A rule above this item in the menu. */
  separatorBefore?: boolean;
}

export interface ClipMenuContext {
  kind: 'video' | 'audio' | 'image' | 'text' | 'adjustment';
  /** True when the playhead is strictly inside the clip, so there is something to cut. */
  playheadInside: boolean;
  hasAsset: boolean;
  /** An offline clip has no bytes, so nothing can be rendered from it. */
  offline: boolean;
  hasAudio: boolean;
  audioEnabled: boolean;
  hideVideo: boolean;
  trackLocked: boolean;
  /** A producer is already running; only one may at a time. */
  producerBusy: boolean;
  selectionCount: number;
}

/** The menu for one clip, in order. */
export function clipMenuItems(ctx: ClipMenuContext): ClipMenuItem[] {
  const items: ClipMenuItem[] = [];
  const many = ctx.selectionCount > 1;
  const locked = ctx.trackLocked ? 'This track is locked.' : undefined;

  items.push({
    id: 'split',
    label: 'Split at playhead',
    accel: 'S',
    disabled: !!locked || !ctx.playheadInside,
    reason: locked ?? (ctx.playheadInside ? undefined : 'Put the playhead inside the clip.'),
  });
  // Trimming to the playhead is the other half of splitting: cut here and throw away the
  // side you did not want, without the intermediate clip you then have to select and delete.
  items.push({
    id: 'trimStart',
    label: 'Trim start to playhead',
    disabled: !!locked || !ctx.playheadInside,
    reason: locked ?? (ctx.playheadInside ? undefined : 'Put the playhead inside the clip.'),
  });
  items.push({
    id: 'trimEnd',
    label: 'Trim end to playhead',
    disabled: !!locked || !ctx.playheadInside,
    reason: locked ?? (ctx.playheadInside ? undefined : 'Put the playhead inside the clip.'),
  });

  items.push({
    id: 'duplicate',
    label: many ? `Duplicate ${ctx.selectionCount} clips` : 'Duplicate',
    accel: '⌘D',
    disabled: !!locked,
    reason: locked,
    separatorBefore: true,
  });

  if (ctx.kind === 'video' || ctx.kind === 'image') {
    const cannotRender =
      locked ??
      (!ctx.hasAsset
        ? 'This clip has no source file.'
        : ctx.offline
          ? 'The source file is offline — relink it first.'
          : ctx.producerBusy
            ? 'Another job is already running.'
            : undefined);
    items.push({
      id: 'bake',
      label: 'Bake this range to the library…',
      disabled: !!cannotRender,
      reason: cannotRender,
      separatorBefore: true,
    });
    if (ctx.kind === 'video') {
      items.push({
        id: 'preset',
        label: 'Run a preset on this range…',
        disabled: !!cannotRender,
        reason: cannotRender,
      });
    }
  }

  if (ctx.kind === 'video') {
    items.push({
      id: 'detach',
      label: 'Detach audio',
      disabled: !!locked || !ctx.hasAudio,
      reason: locked ?? (ctx.hasAudio ? undefined : 'This file has no audio track.'),
      separatorBefore: true,
    });
    items.push({
      id: 'toggleAudio',
      label: ctx.audioEnabled ? 'Mute this clip' : 'Unmute this clip',
      disabled: !!locked || !ctx.hasAudio,
      reason: locked ?? (ctx.hasAudio ? undefined : 'This file has no audio track.'),
    });
    items.push({
      id: 'toggleVideo',
      label: ctx.hideVideo ? 'Show video' : 'Hide video',
      disabled: !!locked,
      reason: locked,
    });
  }

  // No mute for an audio clip. A video clip has an `audioEnabled` flag that remembers its
  // gain underneath; an audio clip has only the gain, so "mute" here would have to be a gain
  // of zero — and unmuting would then guess at what it used to be. The inspector's volume
  // slider is the honest control for that, and it is one click away.

  items.push({ id: 'zoom', label: 'Zoom to clip', accel: 'Z', separatorBefore: true });

  items.push({
    id: 'delete',
    label: many ? `Delete ${ctx.selectionCount} clips` : 'Delete',
    accel: '⌫',
    disabled: !!locked,
    reason: locked,
    danger: true,
    separatorBefore: true,
  });
  items.push({
    id: 'rippleDelete',
    label: many ? `Ripple delete ${ctx.selectionCount} clips` : 'Ripple delete',
    accel: '⇧⌫',
    disabled: !!locked,
    reason: locked,
    danger: true,
  });

  return items;
}

export interface MenuBox {
  width: number;
  height: number;
}

/**
 * Where the menu actually goes.
 *
 * A menu opened near the right or bottom edge flips back over the pointer rather than
 * hanging off the window — the timeline lives at the bottom of the screen, so *every*
 * right-click down there is the edge case.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  menu: MenuBox,
  viewport: { width: number; height: number },
  margin = 6,
): { x: number; y: number } {
  const left =
    x + menu.width + margin > viewport.width ? Math.max(margin, x - menu.width) : x;
  const top =
    y + menu.height + margin > viewport.height ? Math.max(margin, y - menu.height) : y;
  return { x: Math.min(left, Math.max(margin, viewport.width - menu.width - margin)), y: Math.min(top, Math.max(margin, viewport.height - menu.height - margin)) };
}
