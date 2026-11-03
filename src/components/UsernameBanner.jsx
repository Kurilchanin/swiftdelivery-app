// A red bar shown on the create page when the user has no Telegram @username. A
// handle is required to create or accept an order — the other party must be able
// to reach them — so we nudge the user to set one. Viewing orders (and seeing the
// client's contact) still works without a @username; only creating/accepting is
// blocked, and those flows have their own inline checks.
import { hasTelegramUsername } from '../contact'
import { t } from '../i18n'

export default function UsernameBanner() {
  if (hasTelegramUsername()) return null
  return (
    <div className="top-banner username-banner" role="alert">
      {t('banner.noUsername')}
    </div>
  )
}
