// One order shown as a card in a list. Tapping it opens the detail page.
import { navigate } from '../router'
import { sanitizeText } from '../utils/security'
import StatusBadge from './StatusBadge'
import Icon from './Icon'
import { t } from '../i18n'

export default function OrderCard({ order }) {
  return (
    <button
      type="button"
      className="order-card"
      onClick={() => navigate('/order/' + encodeURIComponent(order.address))}
    >
      <div className="order-card-top">
        <span className={'order-icon is-' + order.status.toLowerCase()} aria-hidden="true">
          <Icon name="box" />
        </span>
        <span className="order-route">
          <span className="area">{t('label.to')}: {sanitizeText(order.area, 200)}</span>
          {order.origin && (
            <span className="origin">{t('label.from')}: {sanitizeText(order.origin, 200)}</span>
          )}
        </span>
        <span className="order-amount">
          <span className="reward">
            <bdi>{order.reward} USDT</bdi>
          </span>
          <StatusBadge status={order.status} />
        </span>
      </div>
      <p className="desc">{sanitizeText(order.description, 500)}</p>
    </button>
  )
}
