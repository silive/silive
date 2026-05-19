const REVIEW_MODE = true
const REVIEW_PAYMENT_ENABLED = true

function isReviewMode() {
  return REVIEW_MODE
}

function isPaymentEnabled() {
  return REVIEW_PAYMENT_ENABLED
}

function filterReviewHomeEntries(entries = []) {
  if (!REVIEW_MODE) return entries
  const allowedTargets = new Set(["primary", "secondary", "product", "productList", "poster", "none"])
  return (entries || []).filter(entry => allowedTargets.has(entry.targetType || entry.linkType || "primary"))
}

module.exports = {
  REVIEW_MODE,
  REVIEW_PAYMENT_ENABLED,
  isReviewMode,
  isPaymentEnabled,
  filterReviewHomeEntries
}
