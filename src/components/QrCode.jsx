// Renders text as a QR code image. Used to show the client's delivery code so the
// courier can scan it at hand-off. The QR itself stays black-on-white (standard,
// so any scanner reads it reliably) and sits on a white rounded pad on the
// dark page. The encoding runs off the main paint in an effect, then we show the
// resulting data-URL in an <img>.
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export default function QrCode({ text, size = 220 }) {
  const [url, setUrl] = useState('')

  useEffect(() => {
    let alive = true
    if (!text) return
    QRCode.toDataURL(text, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((u) => {
        if (alive) setUrl(u)
      })
      .catch(() => {
        if (alive) setUrl('')
      })
    return () => {
      alive = false
    }
  }, [text, size])

  if (!url) return null
  return (
    <div className="qr-box">
      <img className="qr" src={url} width={size} height={size} alt="QR" />
    </div>
  )
}
