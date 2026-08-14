import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { parseMediaUrlsFromSearch, stripMediaParamsFromSearch } from '../utils/urlMedia';

/** On load, fetch files from ?media= / ?url= / ?file= query params into the media library. */
export function useUrlMediaImport(): void {
  const importUrlsToLibrary = useEditorStore((s) => s.importUrlsToLibrary);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const urls = parseMediaUrlsFromSearch(window.location.search);
    if (urls.length === 0) return;

    const cleanSearch = stripMediaParamsFromSearch(window.location.search);
    const nextUrl = `${window.location.pathname}${cleanSearch}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', nextUrl);

    void importUrlsToLibrary(urls);
  }, [importUrlsToLibrary]);
}
