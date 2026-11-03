// The one and only component for external links.
// It checks the URL and always sets rel="noopener noreferrer".
import { assertHttpUrl } from '../utils/security'

export default function ExtLink({ href, children, ...props }) {
  const safe = assertHttpUrl(href)
  if (!safe) {
    // Not a valid http(s) link: render plain text, never a live link.
    return <span {...props}>{children}</span>
  }
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  )
}
