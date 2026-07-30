// components/modals/BackupDestinationModal.jsx — Add a saved backup destination
// (S3 bucket or a folder on another registered device). Admin + action PIN,
// same gate as every other credential-holding mutation in this app.
import React, { useState, useEffect } from 'react'
import { X, Cloud, CloudCog, FolderInput, Shield, Loader2 } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'
import { getErrorMessage } from '../../lib/errors'

function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="label">{label}</label>
      {children}
    </div>
  )
}

const TYPE_OPTIONS = [
  { value: 's3', label: 'S3 bucket', icon: Cloud },
  { value: 'azure_blob', label: 'Azure Blob', icon: CloudCog },
  { value: 'remote_folder', label: 'Folder on another device', icon: FolderInput },
]

export default function BackupDestinationModal({ open, onClose, onCreated, devices, editing }) {
  const isEditing = !!editing
  const [type, setType] = useState('s3')
  const [name, setName] = useState('')
  const [bucket, setBucket] = useState('')
  const [region, setRegion] = useState('us-east-1')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [prefix, setPrefix] = useState('')
  const [azureAuthMode, setAzureAuthMode] = useState('connectionString')
  const [azureConnectionString, setAzureConnectionString] = useState('')
  const [azureAccountName, setAzureAccountName] = useState('')
  const [azureAccountKey, setAzureAccountKey] = useState('')
  const [azureContainer, setAzureContainer] = useState('')
  const [azurePrefix, setAzurePrefix] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [pin, setPin] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const remoteDevices = (devices || []).filter(d => !d.isLocal && d.sshCapable)

  useEffect(() => {
    if (!open) return
    if (editing) {
      setType(editing.type)
      setName(editing.name)
      setBucket(editing.config?.bucket || '')
      setRegion(editing.config?.region || 'us-east-1')
      setAccessKeyId('') // masked server-side — left blank, kept unless retyped
      setSecretAccessKey('')
      setPrefix(editing.config?.prefix || '')
      setAzureAuthMode(editing.config?.authMode === 'accountKey' ? 'accountKey' : 'connectionString')
      setAzureConnectionString('')
      setAzureAccountName(editing.config?.accountName || '')
      setAzureAccountKey('')
      setAzureContainer(editing.config?.container || '')
      setAzurePrefix(editing.config?.prefix || '')
      setDeviceId(editing.config?.deviceId || remoteDevices[0]?.id || '')
      setRemotePath(editing.config?.remotePath || '')
      setPin(''); setError('')
    } else {
      setType('s3'); setName(''); setBucket(''); setRegion('us-east-1')
      setAccessKeyId(''); setSecretAccessKey(''); setPrefix('')
      setAzureAuthMode('connectionString'); setAzureConnectionString('')
      setAzureAccountName(''); setAzureAccountKey(''); setAzureContainer(''); setAzurePrefix('')
      setDeviceId(remoteDevices[0]?.id || ''); setRemotePath('')
      setPin(''); setError('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing])

  if (!open) return null

  // Editing an S3 destination: access/secret key can be left blank to keep
  // the existing (encrypted, never sent back to the client) value — only
  // bucket/region/name/prefix are required to resubmit.
  const canSubmit = name.trim() && pin.trim() && (
    type === 's3'
      ? bucket.trim() && region.trim() && (isEditing || (accessKeyId.trim() && secretAccessKey.trim()))
      : type === 'azure_blob'
        ? azureContainer.trim() && (
            azureAuthMode === 'connectionString'
              ? (isEditing || azureConnectionString.trim())
              : (azureAccountName.trim() && (isEditing || azureAccountKey.trim()))
          )
        : deviceId && remotePath.trim()
  )

  const handleSubmit = async () => {
    if (!canSubmit || saving) return
    setSaving(true); setError('')
    try {
      const config = type === 's3'
        ? {
            bucket: bucket.trim(), region: region.trim(), prefix: prefix.trim() || undefined,
            ...(accessKeyId.trim() ? { accessKeyId: accessKeyId.trim() } : {}),
            ...(secretAccessKey.trim() ? { secretAccessKey: secretAccessKey.trim() } : {}),
          }
        : type === 'azure_blob'
          ? {
              container: azureContainer.trim(), prefix: azurePrefix.trim() || undefined,
              ...(azureAuthMode === 'connectionString'
                ? (azureConnectionString.trim() ? { connectionString: azureConnectionString.trim() } : {})
                : {
                    accountName: azureAccountName.trim(),
                    ...(azureAccountKey.trim() ? { accountKey: azureAccountKey.trim() } : {}),
                  }),
            }
          : { deviceId, remotePath: remotePath.trim() }

      const { data } = isEditing
        ? await api.put(`/backup/destinations/${editing.id}`, { name: name.trim(), config, actionPin: pin })
        : await api.post('/backup/destinations', { name: name.trim(), type, config, actionPin: pin })
      toast.success(`Destination "${data.name}" ${isEditing ? 'updated' : 'added'}`)
      onCreated?.(data)
      onClose()
    } catch (err) {
      setError(getErrorMessage(err, `Failed to ${isEditing ? 'update' : 'add'} destination`))
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-md animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'rgba(108,92,231,0.25)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
          <div className="h-0.5 opacity-70 bg-[#6c5ce7]" />

          <div className="flex items-start justify-between p-6 pb-4">
            <div>
              <h3 className="text-lg font-heading font-bold" style={{ color: 'var(--text-primary)' }}>{isEditing ? 'Edit Backup Destination' : 'Add Backup Destination'}</h3>
              <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>Where a backup can be written, besides local storage</p>
            </div>
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
          </div>

          <div className="px-6 pb-6 space-y-4 max-h-[70vh] overflow-y-auto">
            {isEditing ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-body" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
                {(() => { const Icon = TYPE_OPTIONS.find(o => o.value === type)?.icon || Cloud; return <Icon size={14} className="text-brand-400 shrink-0" /> })()}
                <span>{TYPE_OPTIONS.find(o => o.value === type)?.label} — type can't be changed after creation. Delete and re-add to switch kinds.</span>
              </div>
            ) : (
              <div className="flex gap-2">
                {TYPE_OPTIONS.map(opt => {
                  const Icon = opt.icon
                  return (
                    <button key={opt.value} onClick={() => setType(opt.value)}
                      className={`flex-1 flex flex-col items-center gap-1.5 py-3 rounded-xl border text-xs font-body transition-all ${type === opt.value ? 'border-brand-500/50 bg-brand-500/10' : ''}`}
                      style={type !== opt.value ? { borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' } : { color: 'var(--text-primary)' }}>
                      <Icon size={18} className={type === opt.value ? 'text-brand-400' : ''} />
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            )}

            <Field label="Name">
              <input className="input-field" placeholder={type === 's3' ? 'e.g. Cold storage bucket' : 'e.g. Lab archive folder'}
                value={name} onChange={e => setName(e.target.value)} maxLength={100} />
            </Field>

            {type === 's3' ? (
              <>
                <Field label="Bucket"><input className="input-field" value={bucket} onChange={e => setBucket(e.target.value)} placeholder="my-backups-bucket" /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Region"><input className="input-field" value={region} onChange={e => setRegion(e.target.value)} placeholder="us-east-1" /></Field>
                  <Field label="Prefix (optional)"><input className="input-field" value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="netcontrol-backups" /></Field>
                </div>
                <Field label={isEditing ? 'Access key ID (leave blank to keep existing)' : 'Access key ID'}>
                  <input className="input-field font-mono" value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} autoComplete="off" placeholder={isEditing ? editing?.config?.accessKeyId || '' : ''} />
                </Field>
                <Field label={isEditing ? 'Secret access key (leave blank to keep existing)' : 'Secret access key'}>
                  <input type="password" className="input-field font-mono" value={secretAccessKey} onChange={e => setSecretAccessKey(e.target.value)} autoComplete="off" />
                </Field>
              </>
            ) : type === 'azure_blob' ? (
              <>
                <Field label="Container"><input className="input-field" value={azureContainer} onChange={e => setAzureContainer(e.target.value)} placeholder="netcontrol-backups" /></Field>
                <Field label="Prefix (optional)"><input className="input-field" value={azurePrefix} onChange={e => setAzurePrefix(e.target.value)} placeholder="backups/" /></Field>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAzureAuthMode('connectionString')}
                    className={`flex-1 py-2 rounded-lg border text-xs font-body ${azureAuthMode === 'connectionString' ? 'border-brand-500/50 bg-brand-500/10' : ''}`}
                    style={azureAuthMode !== 'connectionString' ? { borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' } : { color: 'var(--text-primary)' }}>
                    Connection string
                  </button>
                  <button type="button" onClick={() => setAzureAuthMode('accountKey')}
                    className={`flex-1 py-2 rounded-lg border text-xs font-body ${azureAuthMode === 'accountKey' ? 'border-brand-500/50 bg-brand-500/10' : ''}`}
                    style={azureAuthMode !== 'accountKey' ? { borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' } : { color: 'var(--text-primary)' }}>
                    Account name + key
                  </button>
                </div>
                {azureAuthMode === 'connectionString' ? (
                  <Field label={isEditing ? 'Connection string (leave blank to keep existing)' : 'Connection string'}>
                    <input type="password" className="input-field font-mono" value={azureConnectionString} onChange={e => setAzureConnectionString(e.target.value)} autoComplete="off" placeholder="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;" />
                  </Field>
                ) : (
                  <>
                    <Field label="Storage account name"><input className="input-field font-mono" value={azureAccountName} onChange={e => setAzureAccountName(e.target.value)} autoComplete="off" /></Field>
                    <Field label={isEditing ? 'Account key (leave blank to keep existing)' : 'Account key'}>
                      <input type="password" className="input-field font-mono" value={azureAccountKey} onChange={e => setAzureAccountKey(e.target.value)} autoComplete="off" />
                    </Field>
                  </>
                )}
              </>
            ) : (
              <>
                <Field label="Device">
                  {remoteDevices.length === 0 ? (
                    <p className="text-xs font-body px-1" style={{ color: 'var(--text-muted)' }}>No devices with SSH credentials configured yet — add SSH credentials to a device under Devices to use it as a destination.</p>
                  ) : (
                    <select className="input-field" value={deviceId} onChange={e => setDeviceId(e.target.value)}>
                      {remoteDevices.map(d => <option key={d.id} value={d.id}>{d.name} ({d.ip_address})</option>)}
                    </select>
                  )}
                </Field>
                <Field label="Remote folder path"><input className="input-field font-mono" value={remotePath} onChange={e => setRemotePath(e.target.value)} placeholder="/srv/backups" /></Field>
              </>
            )}

            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border text-xs font-body" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
              <Shield size={14} className="text-brand-400 shrink-0 mt-0.5" />
              <span>{type === 'local' ? 'Local archives are stored as-is unless BACKUP_ENCRYPT_LOCAL is enabled on the server.' : 'Archives sent to this destination are always AES-256-GCM encrypted before they leave this server.'}</span>
            </div>

            <Field label="Action PIN">
              <div className="relative">
                <Shield size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-400" />
                <input type="password" className="input-field pl-8" value={pin} onChange={e => setPin(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && canSubmit && handleSubmit()} autoComplete="off" />
              </div>
            </Field>

            {error && <p className="text-xs font-mono text-accent-red">{error}</p>}

            <button onClick={handleSubmit} disabled={!canSubmit || saving}
              className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
              {saving ? <><Loader2 size={15} className="animate-spin" /> Saving…</> : (isEditing ? 'Save Changes' : 'Add Destination')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}