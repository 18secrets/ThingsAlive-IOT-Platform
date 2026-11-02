import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Message, useToaster } from 'rsuite';
import { MutationNotice, onMutationNotice } from '../../lib/mutationNotice';

/**
 * The toast every create, update and delete raises: green when it worked, red with
 * the server's reason when it did not, top right (tester request, 26 Oct 2026).
 * Mounted once, inside rsuite's provider so it follows light and dark mode.
 */
export const MutationToasts: React.FC = () => {
  const toaster = useToaster();
  const { t } = useTranslation();

  useEffect(() => onMutationNotice((notice: MutationNotice) => {
    const title = notice.ok
      ? t(notice.kind === 'delete' ? 'toast.deleted' : 'toast.saved')
      : t(notice.kind === 'delete' ? 'toast.deleteFailed' : 'toast.saveFailed');
    // A failure stays a little longer: it has a reason to read.
    toaster.push(
      <Message showIcon closable type={notice.ok ? 'success' : 'error'} header={title}>
        {notice.ok === false ? notice.message ?? t('toast.noReason') : null}
      </Message>,
      { placement: 'topEnd', duration: notice.ok ? 3000 : 6000 },
    );
  }), [toaster, t]);

  return null;
};
