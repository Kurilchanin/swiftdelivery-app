// A small colored label for the order status. `status` is the contract's
// English logic key (Open/Accepted/…); the CSS class stays on that key, only
// the visible text is translated.
import { t } from '../i18n'

export default function StatusBadge({ status }) {
  return (
    <span className={'badge badge-' + status.toLowerCase()}>{t('status.' + status)}</span>
  )
}
