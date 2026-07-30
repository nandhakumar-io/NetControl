// src/lib/errors.js — single place that knows how to turn any axios/API
// error into a user-facing string. Backend responses aren't 100% uniform
// (some routes return { error }, express-validator failures return
// { errors: [{ msg }, ...] }, and anything that falls through to the global
// handler in server.js also returns { error }) — this normalizes all of
// that so every modal's catch block can just do:
//   catch (err) { toast.error(getErrorMessage(err, 'Save failed')) }
// instead of re-deriving the same `?.response?.data?.error || ...` chain
// (and forgetting the express-validator case) in twenty different files.
export function getErrorMessage(err, fallback = 'Something went wrong') {
  if (!err) return fallback

  // Network-level failure — request never got a response (offline, CORS,
  // timeout, backend down). err.response is undefined in this case.
  if (!err.response) {
    if (err.code === 'ECONNABORTED') return 'Request timed out — please try again'
    if (err.message === 'Network Error') return 'Network error — check your connection'
    return err.message || fallback
  }

  const data = err.response.data

  // Standard shape used across the app: { error: 'message' }
  if (data?.error && typeof data.error === 'string') return data.error

  // express-validator shape: { errors: [{ msg: 'message' }, ...] }
  if (Array.isArray(data?.errors) && data.errors.length) {
    const first = data.errors[0]
    if (typeof first === 'string') return first
    if (first?.msg) return first.msg
  }

  // Some older/edge routes may use { message } instead of { error }
  if (data?.message && typeof data.message === 'string') return data.message

  // Last resort: HTTP status text, then the caller's fallback
  if (err.response.status && err.response.statusText) {
    return `${err.response.statusText} (${err.response.status})`
  }

  return fallback
}

export default getErrorMessage