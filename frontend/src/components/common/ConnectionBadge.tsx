import React from 'react';
import { useTranslation } from 'react-i18next';
import { Chip } from './Chip';

/**
 * What the Connection status filter acts on, shown on the card it filters. Without it
 * the filter hid and showed cards for a reason nobody could see. `null` is a machine
 * with no device-health verdict at all — it matches neither Online nor Offline, so it
 * says "no link data" rather than being read as either.
 */
export const ConnectionBadge: React.FC<{ state: 'online' | 'offline' | null }> = ({ state }) => {
  const { t } = useTranslation('shared');
  return state === 'online' ? <Chip tone="emerald" title={t('connection.onlineHint')}>{t('connection.online')}</Chip>
    : state === 'offline' ? <Chip tone="rose" title={t('connection.offlineHint')}>{t('connection.offline')}</Chip>
      : <Chip tone="slate" title={t('connection.noDataHint')}>{t('connection.noData')}</Chip>;
};
