// The bar at the very top of every page. On testnet it shouts a loud TESTNET
// warning; on mainnet it shows the Marketplace contract address so a user can
// see which contract the app talks to. Same slot, same style (.top-banner).
import { IS_TESTNET, MARKETPLACE_ADDRESS, displayAddr } from '../ton/network'
import ExtLink from './ExtLink'
import Icon from './Icon'
import { t } from '../i18n'

const CONTRACTS_REPO_URL = 'https://github.com/Kurilchanin/swiftdelivery-contracts'

export default function TopBanner() {
  if (IS_TESTNET) {
    return (
      <div className="top-banner is-warn" role="status">
        {t('testnet.banner')}
      </div>
    )
  }
  return (
    <div className="top-banner" role="status">
      <Icon name="shield" size={16} />
      {/* The address keeps its exact case (base64url is case-sensitive). A
          contract, so the bounceable EQ… form, matching Tonviewer. */}
      <ExtLink href={CONTRACTS_REPO_URL} className="banner-addr mono">
        {displayAddr(MARKETPLACE_ADDRESS, 'contract')}
      </ExtLink>
    </div>
  )
}
