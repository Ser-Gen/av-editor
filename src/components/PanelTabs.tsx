export interface PanelTab<T extends string> {
  id: T;
  label: string;
  /** A dot on the tab: something in there wants attention while you are looking elsewhere. */
  marked?: boolean;
}

interface Props<T extends string> {
  tabs: PanelTab<T>[];
  active: T | null;
  onSelect: (id: T) => void;
}

/**
 * The tab strip at the top of a sidebar.
 *
 * A tab is only listed when it has something to show for the current selection, so the strip
 * for an audio clip is shorter than the one for a video clip rather than offering two dead
 * ends. `marked` exists because hiding a panel behind a tab can hide a live recording with
 * it; the dot is how the tab says so.
 */
export function PanelTabs<T extends string>({ tabs, active, onSelect }: Props<T>) {
  if (tabs.length < 2) return null;
  return (
    <nav className="panel-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={`panel-tab${tab.id === active ? ' is-active' : ''}`}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
          {tab.marked && <span className="panel-tab-dot" aria-hidden />}
        </button>
      ))}
    </nav>
  );
}
