import { useEffect, useState } from 'react';

/** A section's data, or that it could not be read — most often because the role does
 *  not hold the capability, which is a normal state for an overview page, not an error. */
export type Slot<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'unavailable' };

/** Loads once per mount (or when `deps` change), independently of every other slot, so
 *  one refused section never blanks the rest of the page. */
export function useSlot<T>(load: () => Promise<T>, deps: unknown[] = []): Slot<T> {
  const [slot, setSlot] = useState<Slot<T>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    setSlot({ state: 'loading' });
    load().then((data) => { if (live) setSlot({ state: 'ok', data }); }).catch(() => { if (live) setSlot({ state: 'unavailable' }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return slot;
}
