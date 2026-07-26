import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Reads a `?highlight=<id>` query param (as set by CommandPalette /
 * global search "press Enter" navigation) and:
 *  - returns the id (string) so the page can mark the matching row/card
 *  - once `ready` is true (data loaded / filters cleared), scrolls the
 *    element with id={`hl-${id}`} into view
 *  - strips the param from the URL after a few seconds so a page refresh
 *    or back-navigation doesn't keep re-triggering the highlight
 *
 * @param {boolean} ready - whether the page's data/list is loaded and
 *   safe to scroll against (pass `!loading && list.length > 0` etc.)
 * @returns {string|null} the highlighted id, or null if none/consumed
 */
export function useHighlightParam(ready) {
  const [searchParams, setSearchParams] = useSearchParams()
  const highlightId = searchParams.get('highlight')
  const [scrolled, setScrolled] = useState(false)
  const clearTimer = useRef(null)

  // Scroll to the target once the page says it's ready to receive it.
  useEffect(() => {
    if (!highlightId || !ready || scrolled) return
    const el = document.getElementById(`hl-${highlightId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setScrolled(true)
    }
  }, [highlightId, ready, scrolled])

  // Drop the query param a little after arrival so the highlight doesn't
  // linger forever on refresh/back-nav, without yanking it away before
  // the scroll above has had a chance to run.
  useEffect(() => {
    if (!highlightId) return
    clearTimer.current = setTimeout(() => {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.delete('highlight')
        return next
      }, { replace: true })
    }, 4000)
    return () => clearTimeout(clearTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId])

  return highlightId
}