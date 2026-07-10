// lib/push.js — Web Push subscription helper for the mobile alert triage feature
import api from './api'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

export function isPushSupported() {
  return typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js')
  } catch (e) {
    console.warn('[push] service worker registration failed', e)
    return null
  }
}

export async function getPushSubscriptionState() {
  if (!isPushSupported()) return { supported: false, permission: 'unsupported', subscribed: false }
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  return {
    supported: true,
    permission: Notification.permission, // 'default' | 'granted' | 'denied'
    subscribed: !!sub,
  }
}

// Requests notification permission (if needed), subscribes via the Push API
// using the server's VAPID public key, and registers the subscription with
// the backend so alert notifications can actually be delivered to it.
export async function enablePush() {
  if (!isPushSupported()) throw new Error('Push notifications are not supported in this browser')

  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerServiceWorker())
  if (!reg) throw new Error('Could not register the service worker')

  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') throw new Error('Notification permission was not granted')
  } else if (Notification.permission === 'denied') {
    throw new Error('Notifications are blocked for this site — check your browser settings')
  }

  const { data } = await api.get('/push/vapid-public-key')
  const existing = await reg.pushManager.getSubscription()
  const sub = existing || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(data.publicKey),
  })

  await api.post('/push/subscribe', { subscription: sub.toJSON() })
  return sub
}

export async function disablePush() {
  if (!isPushSupported()) return
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  if (!sub) return
  await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
  await sub.unsubscribe().catch(() => {})
}

export async function sendTestPush() {
  return api.post('/push/test')
}