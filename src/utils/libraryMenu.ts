/**
 * What a right-click on a library file offers.
 *
 * Kept apart from the component for the same reason `clipMenu.ts` is: this is where an action
 * gets offered on a file it cannot work on. Every entry that is unavailable says why — a grey
 * row with no explanation is worse than no row at all.
 */

export type LibraryMenuId = 'info' | 'add' | 'download' | 'preset' | 'relink' | 'remove';

export interface LibraryMenuItem {
  id: LibraryMenuId;
  label: string;
  disabled?: boolean;
  /** Why it is disabled, as a tooltip. */
  reason?: string;
  danger?: boolean;
  separatorBefore?: boolean;
}

export interface LibraryMenuContext {
  type: 'video' | 'audio' | 'image';
  /** False while the file is offline: there are no bytes behind it. */
  online: boolean;
  /** A clip on the timeline references it, so removing it would orphan that clip. */
  inUse: boolean;
  /** A preset run is already going; only one may at a time. */
  producerBusy: boolean;
}

export function libraryMenuItems(ctx: LibraryMenuContext): LibraryMenuItem[] {
  const items: LibraryMenuItem[] = [];

  // Always first and never disabled. An offline file is exactly when someone wants to know
  // what it was, and the window can say that from the library's own record.
  items.push({ id: 'info', label: 'File info…' });

  items.push({
    id: 'add',
    label: 'Add to timeline',
    disabled: !ctx.online,
    reason: ctx.online ? undefined : 'This file is offline. Relink it first.',
    separatorBefore: true,
  });

  items.push({
    id: 'download',
    label: 'Download a copy…',
    disabled: !ctx.online,
    reason: ctx.online ? undefined : 'This file is offline. There are no bytes to save.',
  });

  // Presets run through FFmpeg over a video's picture; there is nothing for them to do to an
  // image, and the audio presets do not exist yet.
  if (ctx.type === 'video') {
    items.push({
      id: 'preset',
      label: 'Process with a preset…',
      disabled: !ctx.online || ctx.producerBusy,
      reason: !ctx.online
        ? 'This file is offline. Relink it first.'
        : ctx.producerBusy
          ? 'Another preset is already running.'
          : undefined,
    });
  }

  if (!ctx.online) {
    items.push({ id: 'relink', label: 'Relink…' });
  }

  items.push({
    id: 'remove',
    label: 'Remove from library',
    disabled: ctx.inUse,
    reason: ctx.inUse ? 'A clip on the timeline uses this file.' : undefined,
    danger: true,
    separatorBefore: true,
  });

  return items;
}
