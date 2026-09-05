import { toast } from 'sonner'

/**
 * Consistent, visible feedback when a form is blocked by a missing or invalid field.
 *
 * Most forms in this app mark fields `required` and leave the browser to enforce
 * it: 29 files do, and only two set noValidate. The browser's own bubble is easy
 * to miss, looks nothing like the rest of the UI, vanishes on the next click,
 * and never appears at all if the invalid field is scrolled out of view -- which
 * is how "I pressed Create and nothing happened" happens.
 *
 * The `invalid` event fires on every control that fails constraint validation,
 * so one listener covers every form in the app rather than thirty forms being
 * rewritten one at a time. Forms that do their own validation are unaffected:
 * they set noValidate, so this never fires for them.
 */

/** A name a person would recognise for this field. */
const labelFor = (el) => {
  const byLabel = el.labels?.[0]?.textContent?.trim()
  if (byLabel) return byLabel.replace(/\s*\*\s*$/, '')

  const aria = el.getAttribute('aria-label')?.trim()
  if (aria) return aria

  if (el.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()
    if (forLabel) return forLabel.replace(/\s*\*\s*$/, '')
  }

  const placeholder = el.getAttribute('placeholder')?.trim()
  // "Enter category name" reads better as "Category name" in a sentence.
  if (placeholder) return placeholder.replace(/^(enter|type|choose|select|e\.?g\.?)\s+/i, '')

  const name = el.getAttribute('name')?.trim()
  if (name) return name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')

  return 'A required field'
}

// Labels lifted from a placeholder arrive mid-sentence ("category name"), and
// the message puts them at the start of one.
const sentenceCase = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text)

const messageFor = (el) => {
  const label = sentenceCase(labelFor(el))
  const v = el.validity

  if (v?.valueMissing) return `${label} is required`
  if (v?.typeMismatch && el.type === 'email') return `${label} must be a valid email address`
  if (v?.typeMismatch && el.type === 'url') return `${label} must be a valid URL`
  if (v?.rangeUnderflow) return `${label} must be at least ${el.min}`
  if (v?.rangeOverflow) return `${label} must be ${el.max} or less`
  if (v?.tooShort) return `${label} must be at least ${el.minLength} characters`
  if (v?.tooLong) return `${label} must be ${el.maxLength} characters or fewer`
  if (v?.stepMismatch) return `${label} is not a valid amount`
  if (v?.patternMismatch) return `${label} is not in the expected format`
  // Fall back to whatever the browser would have said rather than inventing one.
  return el.validationMessage || `${label} is not valid`
}

export const installFormValidationFeedback = () => {
  if (typeof document === 'undefined' || window.__formFeedbackInstalled) return
  window.__formFeedbackInstalled = true

  // A blocked submit fires `invalid` once per bad control, all in the same tick.
  // Collect them and report the first, so a form with six empty fields shows one
  // message rather than six stacked toasts.
  let pending = []
  let scheduled = false

  const flush = () => {
    scheduled = false
    const fields = pending
    pending = []
    if (!fields.length) return

    const first = fields[0]
    const extra = fields.length - 1
    const message = messageFor(first)

    toast.error(message, {
      id: 'form-validation',
      description: extra > 0
        ? `${extra} other field${extra === 1 ? '' : 's'} still ${extra === 1 ? 'needs' : 'need'} attention.`
        : undefined,
      duration: 4000,
    })

    try {
      first.focus({ preventScroll: true })
      first.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } catch (_) {
      // A detached or hidden control cannot be focused; the message still shows.
    }
  }

  document.addEventListener(
    'invalid',
    (event) => {
      const el = event.target
      if (!el || !el.validity || el.validity.valid) return

      // Suppress the native bubble so there is one style of error in the app,
      // not two. The message below replaces it.
      event.preventDefault()

      pending.push(el)
      if (!scheduled) {
        scheduled = true
        queueMicrotask(flush)
      }
    },
    true, // capture: `invalid` does not bubble
  )
}
