import React, { useState, useEffect } from 'react'
import { X, ShieldCheck, ShieldOff, Copy, Check } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

// Self-service two-factor authentication setup, matching the style of the
// other modals (UserModal, BackupDestinationModal, etc). Mount this from
// wherever the user's account menu lives (e.g. Layout.jsx's profile
// dropdown) with:
//   const [show2FA, setShow2FA] = useState(false)
//   <TwoFactorModal open={show2FA} onClose={() => setShow2FA(false)} />
export default function TwoFactorModal({ open, onClose }) {
  const [status, setStatus] = useState(null) // { enabled }
  const [step, setStep] = useState('status')  // status | setup | confirm | backup-codes | disable
  const [setupData, setSetupData] = useState(null) // { secret, qrDataUrl }
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [backupCodes, setBackupCodes] = useState(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep('status'); setCode(''); setPassword(''); setBackupCodes(null)
    api.get('/users/me/2fa/status').then(({ data }) => setStatus(data)).catch(() => setStatus({ enabled: false }))
  }, [open])

  if (!open) return null

  const startSetup = async () => {
    setLoading(true)
    try {
      const { data } = await api.post('/users/me/2fa/setup')
      setSetupData(data)
      setStep('setup')
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not start 2FA setup')
    } finally { setLoading(false) }
  }

  const confirmSetup = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const { data } = await api.post('/users/me/2fa/confirm', { code: code.trim() })
      setBackupCodes(data.backupCodes)
      setStep('backup-codes')
      toast.success('Two-factor authentication enabled')
    } catch (e) {
      toast.error(e.response?.data?.error || 'Invalid code')
    } finally { setLoading(false) }
  }

  const disable2FA = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      await api.post('/users/me/2fa/disable', { password, code: code.trim() })
      toast.success('Two-factor authentication disabled')
      setStatus({ enabled: false })
      setStep('status')
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not disable 2FA')
    } finally { setLoading(false) }
  }

  const copySecret = () => {
    navigator.clipboard.writeText(setupData.secret)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const copyBackupCodes = () => {
    navigator.clipboard.writeText(backupCodes.join('\n'))
    toast.success('Backup codes copied')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="glass w-full max-w-md rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <h2 className="font-display text-sm flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <ShieldCheck size={16} className="text-brand-400" /> Two-Factor Authentication
          </h2>
          <button onClick={onClose} style={{ color: 'var(--text-muted)' }}>
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          {step === 'status' && status && (
            <div className="flex flex-col gap-4">
              {status.enabled ? (
                <>
                  <p className="text-sm font-body" style={{ color: 'var(--text-secondary)' }}>
                    Two-factor authentication is <span className="text-accent-green">enabled</span> on your account.
                  </p>
                  {status.required ? (
                    <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
                      Your administrator requires 2FA on this account, so it can't be disabled here. Contact them if you need it turned off.
                    </p>
                  ) : (
                    <button className="btn-secondary w-full justify-center" onClick={() => setStep('disable')}>
                      <ShieldOff size={14} /> Disable 2FA
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>
                    Add an authenticator app (Google Authenticator, Authy, 1Password, etc.) as a second sign-in factor.
                  </p>
                  <button className="btn-primary w-full justify-center" onClick={startSetup} disabled={loading}>
                    Set up 2FA
                  </button>
                </>
              )}
            </div>
          )}

          {step === 'setup' && setupData && (
            <form onSubmit={confirmSetup} className="flex flex-col gap-4">
              <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>Scan this QR code with your authenticator app:</p>
              <div className="flex justify-center bg-white rounded-lg p-3">
                <img src={setupData.qrDataUrl} alt="2FA QR code" width={180} height={180} />
              </div>
              <div>
                <label className="label">Or enter this key manually</label>
                <div className="flex items-center gap-2">
                  <code className="input-field text-xs flex-1 truncate">{setupData.secret}</code>
                  <button type="button" onClick={copySecret} className="btn-secondary px-2">
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
              <div>
                <label className="label">Enter the 6-digit code to confirm</label>
                <input
                  className="input-field text-center tracking-[0.3em] font-mono"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  maxLength={6}
                  inputMode="numeric"
                  autoFocus
                />
              </div>
              <button type="submit" className="btn-primary w-full justify-center" disabled={loading}>
                Confirm &amp; Enable
              </button>
            </form>
          )}

          {step === 'backup-codes' && backupCodes && (
            <div className="flex flex-col gap-4">
              <p className="text-sm font-body" style={{ color: 'var(--text-secondary)' }}>
                Save these one-time backup codes somewhere safe. Each can be used once if you lose access to your authenticator app. They won't be shown again.
              </p>
              <div className="grid grid-cols-2 gap-2 bg-black/20 rounded-lg p-3 font-mono text-xs" style={{ color: 'var(--text-primary)' }}>
                {backupCodes.map(c => <div key={c}>{c}</div>)}
              </div>
              <button className="btn-secondary w-full justify-center" onClick={copyBackupCodes}>
                <Copy size={14} /> Copy all codes
              </button>
              <button className="btn-primary w-full justify-center" onClick={onClose}>
                Done
              </button>
            </div>
          )}

          {step === 'disable' && (
            <form onSubmit={disable2FA} className="flex flex-col gap-4">
              <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>Confirm your password and a current code to disable 2FA.</p>
              <div>
                <label className="label">Password</label>
                <input type="password" className="input-field" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
              </div>
              <div>
                <label className="label">Authentication code</label>
                <input className="input-field text-center tracking-[0.3em] font-mono" value={code} onChange={e => setCode(e.target.value)} maxLength={11} />
              </div>
              <button type="submit" className="btn-primary w-full justify-center bg-accent-red/80 hover:bg-accent-red" disabled={loading}>
                Disable 2FA
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}