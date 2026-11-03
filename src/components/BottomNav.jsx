// Bottom tab bar. Four destinations match the four pages, each an icon over its label.
import { usePath } from '../router'
import { t } from '../i18n'
import Icon from './Icon'

const TABS = [
  { to: '/', key: 'nav.feed', icon: 'home' },
  { to: '/create', key: 'nav.create', icon: 'plus' },
  { to: '/my', key: 'nav.my', icon: 'box' },
  { to: '/profile', key: 'nav.profile', icon: 'user' },
]

export default function BottomNav() {
  const path = usePath()
  return (
    <nav className="bottom-nav">
      {TABS.map((tab) => {
        const active = tab.to === '/' ? path === '/' : path.startsWith(tab.to)
        return (
          <a
            key={tab.to}
            href={'#' + tab.to}
            className={'nav-item' + (active ? ' active' : '')}
            aria-current={active ? 'page' : undefined}
          >
            <span className="nav-icon">
              <Icon name={tab.icon} />
            </span>
            <span className="nav-label">{t(tab.key)}</span>
          </a>
        )
      })}
    </nav>
  )
}
