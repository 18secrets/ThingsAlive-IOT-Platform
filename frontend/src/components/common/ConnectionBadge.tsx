import React from 'react';
import { Chip } from './Chip';

/**
 * What the Connection status filter acts on, shown on the card it filters. Without it
 * the filter hid and showed cards for a reason nobody could see. `null` is a machine
 * with no device-health verdict at all — it matches neither Online nor Offline, so it
 * says "no link data" rather than being read as either.
 */
export const ConnectionBadge: React.FC<{ state: 'online' | 'offline' | null }> = ({ state }) => (
  state === 'online' ? <Chip tone="emerald" title="Its logger reported in the latest health window">Online</Chip>
    : state === 'offline' ? <Chip tone="rose" title="Its logger went dark in the latest health window">Offline</Chip>
      : <Chip tone="slate" title="No device-health verdict yet, so it matches neither Online nor Offline">No link data</Chip>
);
